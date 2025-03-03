const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { words } = require('./utils/wordle-list.json');
const PlayerStats = require('./models/PlayerStats');

const app = express();
const httpServer = createServer(app);

// Add body parsing middleware
app.use(express.json());

// Add CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT"]
  },
  // Socket.io configuration
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  upgradeTimeout: 10000,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  maxHttpBufferSize: 1e8,
  path: '/socket.io/',
  connectTimeout: 45000,
  allowEIO3: true
});

// Add error handling for socket server
io.engine.on("connection_error", (err) => {
  console.log('Connection error:', err.req);      // the request object
  console.log('Error message:', err.code);     // the error code
  console.log('Error context:', err.context);  // some additional error context
});

// Store active game rooms
const gameRooms = new Map();
// Store players waiting for quickmatch
const matchmakingQueue = [];
// Store active socket connections
const activeConnections = new Set();
// Store socket to room mapping
const socketRooms = new Map();
// Store socket connection type (matchmaking or game)
const socketTypes = new Map();

// Function to get actual connected clients count
function getActualConnectionCount() {
  return Array.from(io.sockets.sockets.values()).filter(socket => socket.connected).length;
}

// Function to sync connection tracking with actual socket state
function syncConnectionTracking() {
  const connectedSockets = new Set(
    Array.from(io.sockets.sockets.values())
      .filter(socket => socket.connected)
      .map(socket => socket.id)
  );
  
  // Remove any tracked connections that are no longer actually connected
  for (const socketId of activeConnections) {
    if (!connectedSockets.has(socketId)) {
      cleanupPlayer(socketId);
    }
  }
  
  // Add any actual connections that aren't being tracked
  for (const socketId of connectedSockets) {
    if (!activeConnections.has(socketId)) {
      activeConnections.add(socketId);
    }
  }
  
  return connectedSockets.size;
}

// Generate a random room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Select a random word for the game
function getRandomWord() {
  return words[Math.floor(Math.random() * words.length)].toUpperCase();
}

// Create a game room for two players
function createGameRoom(player1Id, player2Id) {
  console.log('\n🎮 Creating game room');
  console.log('Player 1:', player1Id);
  console.log('Player 2:', player2Id);
  
  const roomCode = generateRoomCode();
  const targetWord = getRandomWord();
  
  console.log('Room code:', roomCode);
  console.log('Target word:', targetWord);
  
  // Verify both sockets are still connected
  const player1Socket = io.sockets.sockets.get(player1Id);
  const player2Socket = io.sockets.sockets.get(player2Id);
  
  if (!player1Socket?.connected || !player2Socket?.connected) {
    console.log('One or both players disconnected during room creation');
    return null;
  }
  
  gameRooms.set(roomCode, {
    players: [player1Id, player2Id],
    targetWord,
    status: 'playing',
    guesses: new Map(),
    createdAt: new Date(),
    isQuickMatch: true,
    playerStats: new Map()
  });
  
  // Store room mapping for both players
  socketRooms.set(player1Id, roomCode);
  socketRooms.set(player2Id, roomCode);
  
  // Join both players to the room
  player1Socket.join(roomCode);
  player2Socket.join(roomCode);
  
  console.log('Room created successfully');
  console.log('Current rooms:', Array.from(gameRooms.keys()));
  return roomCode;
}

// Clean up inactive rooms and ensure data consistency
function cleanupInactiveRooms() {
  const now = new Date();
  for (const [roomCode, room] of gameRooms.entries()) {
    // Check if room is inactive (older than 30 minutes or has no active players)
    const isInactive = now - room.createdAt > 30 * 60 * 1000;
    const hasNoActivePlayers = room.players.every(playerId => {
      const socket = io.sockets.sockets.get(playerId);
      return !socket?.connected;
    });
    
    if (isInactive || hasNoActivePlayers) {
      // Clean up socket room mappings
      room.players.forEach(playerId => {
        socketRooms.delete(playerId);
        socketTypes.delete(playerId);
        activeConnections.delete(playerId);
      });
      gameRooms.delete(roomCode);
      console.log('Cleaned up inactive room:', roomCode);
    }
  }
  
  // Sync connection tracking after cleanup
  syncConnectionTracking();
}

// Clean up player from all game-related data structures
function cleanupPlayer(playerId) {
  // Remove from active connections
  activeConnections.delete(playerId);
  
  // Remove from matchmaking queue
  const queueIndex = matchmakingQueue.indexOf(playerId);
  if (queueIndex !== -1) {
    matchmakingQueue.splice(queueIndex, 1);
    console.log('Removed from matchmaking queue');
  }
  
  // Clean up from room if in one
  const roomCode = socketRooms.get(playerId);
  if (roomCode) {
    const room = gameRooms.get(roomCode);
    if (room) {
      // Remove player from room
      room.players = room.players.filter(id => id !== playerId);
      room.guesses.delete(playerId);
      
      // If room is empty or only one player left in quickmatch, clean it up
      if (room.players.length === 0 || (room.isQuickMatch && room.players.length === 1)) {
        room.players.forEach(remainingPlayer => {
          socketRooms.delete(remainingPlayer);
          socketTypes.delete(remainingPlayer);
          activeConnections.delete(remainingPlayer);
        });
        gameRooms.delete(roomCode);
        console.log('Cleaned up room after player left:', roomCode);
      }
    }
    socketRooms.delete(playerId);
  }
  
  // Clean up socket type
  socketTypes.delete(playerId);
}

// Handle matchmaking for a socket
async function handleMatchmaking(socket) {
  console.log('\n🎯 Player joining matchmaking');
  console.log('Player ID:', socket.id);
  console.log('User ID:', socket.userId);
  
  // Verify player is authenticated
  if (!socket.userId) {
    console.log('❌ Player not authenticated');
    socket.emit('matchmakingError', 'Not authenticated');
    return;
  }
  
  // Clean up any existing game state for this socket
  cleanupPlayer(socket.id);
  
  // Mark this socket as matchmaking
  socketTypes.set(socket.id, 'matchmaking');
  
  // Clean up disconnected players from queue
  const connectedPlayers = matchmakingQueue.filter(playerId => {
    const playerSocket = io.sockets.sockets.get(playerId);
    return playerSocket?.connected && playerSocket.userId;
  });
  matchmakingQueue.length = 0;
  matchmakingQueue.push(...connectedPlayers);
  
  // Add player to matchmaking queue if not already in it
  if (!matchmakingQueue.includes(socket.id)) {
    matchmakingQueue.push(socket.id);
    console.log('Queue after adding player:', matchmakingQueue);
    socket.emit('matchmakingJoined');
  }
  
  // If we have 2 players, create a game
  if (matchmakingQueue.length >= 2) {
    console.log('\n🎲 Found match, creating game');
    const player1 = matchmakingQueue.shift();
    const player2 = matchmakingQueue.shift();
    
    console.log('Player 1:', player1);
    console.log('Player 2:', player2);
    
    // Verify both players are still connected and authenticated
    const player1Socket = io.sockets.sockets.get(player1);
    const player2Socket = io.sockets.sockets.get(player2);
    
    if (player1Socket?.connected && player2Socket?.connected && 
        player1Socket.userId && player2Socket.userId) {
      try {
        // Create a new room for these players
        const roomCode = createGameRoom(player1, player2);
        
        if (!roomCode) {
          throw new Error('Failed to create room');
        }
        
        // Update socket types to game
        socketTypes.set(player1, 'game');
        socketTypes.set(player2, 'game');
        
        const room = gameRooms.get(roomCode);
        
        console.log('\n🚀 Starting game');
        console.log('Room code:', roomCode);
        console.log('Room exists:', !!room);
        console.log('Room players:', room.players);
        console.log('Target word:', room.targetWord);
        
        // Get player stats for opponent data
        const player1Stats = await PlayerStats.getStats(player1Socket.userId);
        const player2Stats = await PlayerStats.getStats(player2Socket.userId);
        
        // Notify both players that the game is starting
        player1Socket.emit('gameStart', {
          targetWord: room.targetWord,
          players: room.players,
          roomCode: roomCode,
          opponentData: {
            id: player2,
            username: player2Stats?.username,
            rating: player2Stats?.rating
          }
        });
        
        player2Socket.emit('gameStart', {
          targetWord: room.targetWord,
          players: room.players,
          roomCode: roomCode,
          opponentData: {
            id: player1,
            username: player1Stats?.username,
            rating: player1Stats?.rating
          }
        });
        
        console.log('Game start events emitted');
      } catch (error) {
        console.error('Error during game start:', error);
        // Clean up if something goes wrong
        if (player1Socket?.connected) {
          socketTypes.set(player1, 'matchmaking');
          matchmakingQueue.unshift(player1);
          player1Socket.emit('matchmakingError', 'Failed to start game');
        }
        if (player2Socket?.connected) {
          socketTypes.set(player2, 'matchmaking');
          matchmakingQueue.unshift(player2);
          player2Socket.emit('matchmakingError', 'Failed to start game');
        }
      }
    } else {
      console.log('One or both players disconnected or not authenticated during matchmaking');
      // Put connected and authenticated players back in queue
      if (player1Socket?.connected && player1Socket.userId) {
        socketTypes.set(player1, 'matchmaking');
        matchmakingQueue.unshift(player1);
      }
      if (player2Socket?.connected && player2Socket.userId) {
        socketTypes.set(player2, 'matchmaking');
        matchmakingQueue.unshift(player2);
      }
    }
  }
}

// Handle player joining a room
function handleJoinRoom(socket, roomCode, callback) {
  try {
    console.log(`\n🎮 === JOIN REQUEST ===`);
    console.log('Room code:', roomCode);
    console.log('Socket ID:', socket.id);
    console.log('Current socket type:', socketTypes.get(socket.id));
    roomCode = roomCode?.toUpperCase();

    // Validate room code
    if (!roomCode) {
      console.log('❌ Invalid room code');
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Invalid room code' });
      }
      return;
    }

    const room = gameRooms.get(roomCode);
    if (!room) {
      console.log(`❌ Room not found: ${roomCode}`);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Room not found' });
      }
      return;
    }

    if (room.players.length >= 2) {
      console.log(`❌ Room ${roomCode} is full`);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Room is full' });
      }
      return;
    }

    // Check if player is already in the room
    if (room.players.includes(socket.id)) {
      console.log(`⚠️ Player ${socket.id} is already in room ${roomCode}`);
      if (typeof callback === 'function') {
        callback({ 
          success: true,
          targetWord: room.targetWord,
          players: room.players,
          roomCode: roomCode
        });
      }
      return;
    }

    // Add player to room
    room.players.push(socket.id);
    socketRooms.set(socket.id, roomCode);
    socketTypes.set(socket.id, 'game'); // Set socket type to game
    socket.join(roomCode);

    console.log(`\n✅ === PLAYER JOINED ===`);
    console.log('Player ID:', socket.id);
    console.log('Room code:', roomCode);
    console.log('Room players:', room.players);
    console.log('Socket type:', socketTypes.get(socket.id));
    console.log('=====================\n');

    // Send success response to joining player
    if (typeof callback === 'function') {
      callback({ 
        success: true,
        targetWord: room.targetWord,
        players: room.players,
        roomCode: roomCode,
        playerId: socket.id
      });
    }

    // Notify other players in the room
    socket.to(roomCode).emit('playerJoined', {
      playerId: socket.id,
      players: room.players
    });

    // Start game if room is full
    if (room.players.length === 2) {
      room.status = 'playing';
      io.to(roomCode).emit('gameStart', {
        targetWord: room.targetWord,
        players: room.players,
        roomCode: roomCode
      });
    }
  } catch (error) {
    console.error('❌ Error joining room:', error);
    if (typeof callback === 'function') {
      callback({ success: false, error: 'Failed to join room' });
    }
  }
}

io.on('connection', (socket) => {
  console.log('\n🔌 New client connected');
  console.log('Socket ID:', socket.id);
  console.log('Transport:', socket.conn.transport.name);
  
  // Add to active connections
  activeConnections.add(socket.id);
  const actualConnections = getActualConnectionCount();
  console.log('Active connections:', activeConnections.size);
  console.log('Actual socket connections:', actualConnections);

  // Handle room creation
  socket.on('createRoom', (callback) => {
    try {
      console.log('\n🎮 === CREATING NEW ROOM ===');
      console.log('Creator ID:', socket.id);
      console.log('Current socket type:', socketTypes.get(socket.id));

      // Generate a unique room code
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (gameRooms.has(roomCode));

      // Create the room
      const room = {
        players: [socket.id],
        targetWord: getRandomWord(),
        status: 'waiting',
        guesses: new Map(),
        createdAt: new Date(),
        isQuickMatch: false
      };

      // Store room data
      gameRooms.set(roomCode, room);
      socketRooms.set(socket.id, roomCode);
      socketTypes.set(socket.id, 'game'); // Set socket type to game
      socket.join(roomCode);

      console.log('\n✅ === ROOM CREATED ===');
      console.log('Room code:', roomCode);
      console.log('Target word:', room.targetWord);
      console.log('Creator ID:', socket.id);
      console.log('Socket type:', socketTypes.get(socket.id));
      console.log('===================\n');

      // Send success response
      if (typeof callback === 'function') {
        callback({ 
          success: true, 
          roomCode,
          playerId: socket.id,
          players: [socket.id]
        });
      }

      // Emit room created event
      socket.emit('roomCreated', { 
        roomCode,
        playerId: socket.id,
        players: [socket.id]
      });
      socket.emit('waitingForPlayer');

    } catch (error) {
      console.error('❌ Error creating room:', error);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Failed to create room' });
      }
    }
  });

  // Handle quickmatch request
  socket.on('joinMatchmaking', () => handleMatchmaking(socket));

  // Handle join room request
  socket.on('joinRoom', ({ roomCode }, callback) => handleJoinRoom(socket, roomCode, callback));

  // Handle leave matchmaking
  socket.on('leaveMatchmaking', () => {
    console.log('\n👋 Player leaving matchmaking');
    console.log('Player ID:', socket.id);
    
    const index = matchmakingQueue.indexOf(socket.id);
    if (index !== -1) {
      matchmakingQueue.splice(index, 1);
      socketTypes.delete(socket.id);
      console.log('Player removed from queue');
      console.log('Current queue:', matchmakingQueue);
    }
  });

  // Handle player guess
  socket.on('makeGuess', ({ roomCode, guess, guessNumber }) => {
    console.log('\n📝 === PLAYER MAKING GUESS ===');
    console.log('Player ID:', socket.id);
    console.log('Room code:', roomCode);
    console.log('Guess:', guess);
    console.log('Guess number:', guessNumber);
    console.log('Socket type:', socketTypes.get(socket.id));
    console.log('Room exists:', gameRooms.has(roomCode));

    // Validate socket type
    const socketType = socketTypes.get(socket.id);
    if (socketType !== 'game') {
      console.log('\n❌ === INVALID GUESS ATTEMPT ===');
      console.log('Socket ID:', socket.id);
      console.log('Socket type:', socketType);
      console.log('Expected type: game');
      console.log('Room code:', roomCode);
      console.log('Room exists:', gameRooms.has(roomCode));
      if (gameRooms.has(roomCode)) {
        console.log('Room players:', gameRooms.get(roomCode).players);
      }
      console.log('Socket room mapping:', socketRooms.get(socket.id));
      console.log('==============================\n');
      return;
    }
    
    const room = gameRooms.get(roomCode);
    if (!room || room.status !== 'playing') {
      console.log('❌ Invalid room or game not in playing state');
      console.log('Room exists:', !!room);
      console.log('Room status:', room?.status);
      return;
    }

    console.log('\n✅ === VALID GUESS ===');
    console.log('Room players:', room.players);
    console.log('Socket room mapping:', socketRooms.get(socket.id));
    console.log('Room is quick match:', room.isQuickMatch);
    console.log('===================\n');

    const playerNumber = room.players.indexOf(socket.id) + 1;
    if (!room.guesses.has(socket.id)) {
      room.guesses.set(socket.id, []);
    }
    
    const playerGuesses = room.guesses.get(socket.id);
    playerGuesses.push(guess);

    console.log('\n📤 === EMITTING GUESS UPDATE ===');
    console.log('To room:', roomCode);
    console.log('From player:', socket.id);
    console.log('Player number:', playerNumber);
    console.log('Guess number:', guessNumber);
    console.log('Is quick match:', room.isQuickMatch);
    console.log('============================\n');

    // Emit guess update to all players in the room
    io.to(roomCode).emit('guessUpdate', {
      playerId: socket.id,
      playerNumber,
      guess,
      guessNumber: guessNumber - 1, // Convert to 0-based index
      isQuickMatch: room.isQuickMatch
    });

    const isCorrect = guess.toUpperCase() === room.targetWord;
    if (isCorrect) {
      console.log('Player won the game!');
      room.status = 'finished';
      io.to(roomCode).emit('gameOver', {
        winner: socket.id,
        winnerNumber: playerNumber,
        targetWord: room.targetWord
      });
      
      // Clean up room after delay
      setTimeout(() => {
        if (gameRooms.has(roomCode)) {
          room.players.forEach(playerId => {
            socketTypes.delete(playerId);
            socketRooms.delete(playerId);
          });
          gameRooms.delete(roomCode);
          console.log('Cleaned up finished game room:', roomCode);
        }
      }, 5000);
    } else if (playerGuesses.length >= 6) {
      const otherPlayer = room.players.find(id => id !== socket.id);
      const otherPlayerGuesses = room.guesses.get(otherPlayer) || [];
      
      if (otherPlayerGuesses.length >= 6) {
        console.log('Game ended in draw');
        room.status = 'finished';
        io.to(roomCode).emit('gameOver', {
          winner: null,
          targetWord: room.targetWord,
          isDraw: true
        });
        
        // Clean up room after delay
        setTimeout(() => {
          if (gameRooms.has(roomCode)) {
            room.players.forEach(playerId => {
              socketTypes.delete(playerId);
              socketRooms.delete(playerId);
            });
            gameRooms.delete(roomCode);
            console.log('Cleaned up finished game room:', roomCode);
          }
        }, 5000);
      }
    }
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    console.log('\n❌ Client disconnected');
    console.log('Socket ID:', socket.id);
    console.log('Disconnect reason:', reason);
    console.log('Socket type:', socketTypes.get(socket.id));
    
    // Get room code before cleanup
    const roomCode = socketRooms.get(socket.id);
    
    // Clean up all player data
    cleanupPlayer(socket.id);
    
    // If player was in a room, notify other players
    if (roomCode) {
      io.to(roomCode).emit('playerLeft', { playerId: socket.id });
    }
    
    // Sync connection tracking and log accurate counts
    const actualConnections = syncConnectionTracking();
    console.log('Tracked connections:', activeConnections.size);
    console.log('Actual socket connections:', actualConnections);
    console.log('Matchmaking queue:', matchmakingQueue.length);
    console.log('Active rooms:', gameRooms.size);
  });

  // Add handler for player authentication
  socket.on('authenticate', async ({ userId, username }) => {
    try {
      console.log('\n🔑 Authentication attempt');
      console.log('User ID:', userId);
      console.log('Username:', username);

      if (!userId || !username) {
        console.log('❌ Missing user data');
        socket.emit('authentication_error', 'Missing user data');
        return;
      }

      let stats = await PlayerStats.getStats(userId);
      if (!stats) {
        console.log('Creating new stats for user');
        stats = await PlayerStats.createStats(userId, username);
      }
      
      socket.userId = userId; // Store userId in socket for later use
      console.log('✅ Authentication successful');
      socket.emit('authenticated', { stats });
    } catch (error) {
      console.error('❌ Authentication error:', error);
      socket.emit('authentication_error', error.message || 'Authentication failed');
    }
  });

  // Update game end handling
  socket.on('gameEnd', async ({ roomCode, won, guesses }) => {
    console.log('\n🎮 === GAME END ===');
    console.log('Room code:', roomCode);
    console.log('Player:', socket.id);
    console.log('Won:', won);
    console.log('Guesses:', guesses.length);

    const room = gameRooms.get(roomCode);
    if (!room) {
      console.log('❌ Room not found');
      return;
    }

    const playerIndex = room.players.indexOf(socket.id);
    if (playerIndex === -1) {
      console.log('❌ Player not in room');
      return;
    }

    try {
      // Get opponent's socket and stats
      const opponentId = room.players[1 - playerIndex];
      const opponentSocket = io.sockets.sockets.get(opponentId);
      const opponentStats = opponentSocket?.userId ? 
        await PlayerStats.getStats(opponentSocket.userId) : null;

      // Update player's stats
      if (socket.userId) {
        console.log('📊 Updating stats for player:', socket.userId);
        const stats = await PlayerStats.updateStats(socket.userId, {
          won,
          guesses: guesses.length,
          opponentRating: opponentStats?.rating
        });

        // Emit updated stats to both players
        io.to(roomCode).emit('statsUpdate', {
          playerId: socket.id,
          stats
        });

        // If both players have finished, update opponent's stats too
        if (room.guesses.size === 2 && opponentSocket?.userId) {
          const opponentWon = !won;
          const opponentGuesses = room.guesses.get(opponentId) || [];
          
          console.log('📊 Updating stats for opponent:', opponentSocket.userId);
          const opponentUpdatedStats = await PlayerStats.updateStats(opponentSocket.userId, {
            won: opponentWon,
            guesses: opponentGuesses.length,
            opponentRating: stats.rating
          });

          io.to(roomCode).emit('statsUpdate', {
            playerId: opponentId,
            stats: opponentUpdatedStats
          });
        }
      }
    } catch (error) {
      console.error('Error updating player stats:', error);
      socket.emit('error', { message: 'Failed to update stats' });
    }
  });
});

// Clean up inactive rooms every minute
setInterval(cleanupInactiveRooms, 60 * 1000);

// Health check endpoint
app.get('/health', (req, res) => {
  const actualConnections = syncConnectionTracking();
  res.json({
    status: 'ok',
    tracked_connections: activeConnections.size,
    actual_connections: actualConnections,
    rooms: gameRooms.size,
    queue: matchmakingQueue.length
  });
});

// Add new endpoint for leaderboard
app.get('/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const leaderboard = await PlayerStats.getLeaderboard(limit);
    res.json(leaderboard);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Add new endpoint for player stats
app.get('/stats/:userId', async (req, res) => {
  try {
    const stats = await PlayerStats.getStats(req.params.userId);
    if (!stats) {
      res.status(404).json({ error: 'Player stats not found' });
      return;
    }
    res.json(stats);
  } catch (error) {
    console.error('Error fetching player stats:', error);
    res.status(500).json({ error: 'Failed to fetch player stats' });
  }
});

// Add these routes before the socket.io setup
app.get('/api/username/check/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const isAvailable = await PlayerStats.isUsernameAvailable(username);
    res.json({ available: isAvailable });
  } catch (error) {
    console.error('Error checking username:', error);
    res.status(500).json({ error: 'Failed to check username availability' });
  }
});

app.put('/api/username/update', async (req, res) => {
  try {
    const { userId, newUsername } = req.body;
    if (!userId || !newUsername) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const updatedStats = await PlayerStats.updateUsername(userId, newUsername);
    res.json(updatedStats);
  } catch (error) {
    console.error('Error updating username:', error);
    if (error.message === 'Username already taken') {
      res.status(409).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update username' });
    }
  }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 