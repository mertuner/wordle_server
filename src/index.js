const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { getRandomWord } = require('./utils/wordUtils');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Enable CORS for all routes with specific configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 200
}));

app.use(express.json());

// Determine allowed origins based on environment
const allowedOrigins = ['*'];  // Allow all origins for now
if (process.env.NODE_ENV === 'production') {
  allowedOrigins.push(process.env.CLIENT_URL_PROD);
}

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: false
  },
  transports: ['polling'],
  pingTimeout: 30000,
  pingInterval: 10000,
  upgradeTimeout: 15000,
  allowUpgrades: false,
  maxHttpBufferSize: 1e6,
  path: '/socket.io'
});

// Store active rooms and matchmaking queue
const rooms = new Map();
const matchmakingQueue = new Set();

// Helper function to log room status
function logRoomStatus(roomCode, action) {
  const room = rooms.get(roomCode);
  console.log('\n=== Room Status ===');
  console.log(`Action: ${action}`);
  console.log(`Total Active Rooms: ${rooms.size}`);
  console.log(`Room Code: ${roomCode}`);
  if (room) {
    console.log(`Room Status: ${room.status}`);
    console.log(`Players: ${room.players.length}`);
    console.log(`Player IDs: ${room.players.join(', ')}`);
    console.log(`Ready Players: ${Array.from(room.readyPlayers || []).join(', ')}`);
    console.log(`Target Word: ${room.targetWord}`);
    console.log(`Created: ${new Date(room.created).toLocaleString()}`);
  }
  console.log('==================\n');
}

// Helper function to create a new room
function createNewRoom(players = []) {
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  const room = {
    players: players,
    status: 'waiting',
    targetWord: getRandomWord(),
    readyPlayers: new Set(),
    created: Date.now(),
    isMatchmaking: players.length > 0
  };
  rooms.set(roomCode, room);
  return roomCode;
}

// Helper function to check and create matches
function checkForMatches() {
  if (matchmakingQueue.size >= 2) {
    const players = Array.from(matchmakingQueue).slice(0, 2);
    const roomCode = createNewRoom(players);
    const room = rooms.get(roomCode);
    
    // Remove matched players from queue and add them to the room
    players.forEach(playerId => {
      matchmakingQueue.delete(playerId);
      const playerSocket = io.sockets.sockets.get(playerId);
      if (playerSocket) {
        playerSocket.join(roomCode);
        room.readyPlayers.add(playerId); // Mark players as ready immediately
      }
    });

    // Start the game immediately since both players are ready
    room.status = 'playing';
    
    // Emit match found to both players with the target word
    io.to(roomCode).emit('matchFound', { 
      roomCode,
      targetWord: room.targetWord,
      players: room.players
    });

    // Emit game start event
    io.to(roomCode).emit('gameStart', {
      targetWord: room.targetWord,
      players: room.players,
      roomCode: roomCode
    });

    logRoomStatus(roomCode, 'Match created and game started');
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('\n=== Server Status ===');
  console.log(`Active Connections: ${io.engine.clientsCount}`);
  console.log(`Active Rooms: ${rooms.size}`);
  console.log('Room Details:');
  rooms.forEach((room, code) => {
    console.log(`- Room ${code}: ${room.players.length} players, status: ${room.status}`);
  });
  console.log('===================\n');

  res.json({
    status: 'ok',
    connections: io.engine.clientsCount,
    rooms: rooms.size,
    roomDetails: Array.from(rooms.entries()).map(([code, room]) => ({
      code,
      players: room.players.length,
      status: room.status
    }))
  });
});

io.on('connection', (socket) => {
  console.log(`\n👤 Client connected: ${socket.id}`);
  console.log(`Total connections: ${io.engine.clientsCount}`);

  // Keep track of the room this socket is in
  let currentRoom = null;

  // Matchmaking events
  socket.on('joinMatchmaking', () => {
    // Remove from any existing room first
    if (currentRoom) {
      const oldRoom = rooms.get(currentRoom);
      if (oldRoom) {
        oldRoom.players = oldRoom.players.filter(id => id !== socket.id);
        oldRoom.readyPlayers.delete(socket.id);
        if (oldRoom.players.length === 0) {
          console.log(`\n🧹 Cleaning up old room ${currentRoom}`);
          rooms.delete(currentRoom);
        }
      }
      currentRoom = null;
    }

    // Add to matchmaking queue
    matchmakingQueue.add(socket.id);
    console.log(`\n🎮 Player ${socket.id} joined matchmaking queue`);
    console.log(`Queue size: ${matchmakingQueue.size}`);

    // Check for possible matches
    checkForMatches();
  });

  socket.on('leaveMatchmaking', () => {
    matchmakingQueue.delete(socket.id);
    console.log(`\n🚶 Player ${socket.id} left matchmaking queue`);
    console.log(`Queue size: ${matchmakingQueue.size}`);
  });

  socket.on('createRoom', (callback) => {
    try {
      // Clean up any existing room this socket might be in
      if (currentRoom) {
        const oldRoom = rooms.get(currentRoom);
        if (oldRoom) {
          oldRoom.players = oldRoom.players.filter(id => id !== socket.id);
          oldRoom.readyPlayers.delete(socket.id);
          if (oldRoom.players.length === 0) {
            console.log(`\n🧹 Cleaning up old room ${currentRoom}`);
            rooms.delete(currentRoom);
          }
        }
      }

      // Generate a unique room code
      let roomCode;
      do {
        roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      } while (rooms.has(roomCode));

      console.log(`\n🎮 Creating room with code: ${roomCode}`);

      // Create the room
      const targetWord = getRandomWord();
      const room = {
        players: [socket.id],
        readyPlayers: new Set([socket.id]), // Mark creator as ready immediately
        targetWord,
        created: Date.now(),
        status: 'waiting',
        guesses: new Map()
      };
      rooms.set(roomCode, room);
      currentRoom = roomCode;

      // Join the new room
      socket.join(roomCode);

      logRoomStatus(roomCode, 'Room Created');
      
      // Send success callback first
      if (typeof callback === 'function') {
        callback({ success: true, roomCode });
      }

      // Then emit room events
      socket.emit('roomCreated', { roomCode });
      socket.emit('waitingForPlayer');
      
      // Emit ready state for creator
      io.to(roomCode).emit('playerReady', {
        playerId: socket.id,
        readyCount: 1
      });

    } catch (error) {
      console.error('❌ Error creating room:', error);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Failed to create room' });
      }
    }
  });

  socket.on('joinRoom', ({ roomCode }, callback) => {
    try {
      console.log(`\n🎮 Join request for room: ${roomCode}`);
      roomCode = roomCode.toUpperCase();
      const room = rooms.get(roomCode);

      if (!room) {
        console.log(`❌ Room not found: ${roomCode}`);
        return callback({ success: false, error: 'Room not found' });
      }

      if (room.players.length >= 2) {
        console.log(`❌ Room ${roomCode} is full`);
        return callback({ success: false, error: 'Room is full' });
      }

      // Check if player is already in the room
      if (room.players.includes(socket.id)) {
        console.log(`⚠️ Player ${socket.id} is already in room ${roomCode}`);
        return callback({ 
          success: true,
          targetWord: room.targetWord,
          players: room.players,
          roomCode: roomCode
        });
      }

      // Clean up any existing room this socket might be in
      if (currentRoom && currentRoom !== roomCode) {
        const oldRoom = rooms.get(currentRoom);
        if (oldRoom) {
          oldRoom.players = oldRoom.players.filter(id => id !== socket.id);
          oldRoom.readyPlayers.delete(socket.id);
          if (oldRoom.players.length === 0) {
            console.log(`\n🧹 Cleaning up old room ${currentRoom}`);
            rooms.delete(currentRoom);
          }
        }
      }

      // Add the player to the room
      room.players.push(socket.id);
      socket.join(roomCode);
      currentRoom = roomCode;

      console.log(`\n✅ Player ${socket.id} joined room ${roomCode}`);
      logRoomStatus(roomCode, 'Player Joined');

      // Send success callback to joining player first
      callback({ 
        success: true,
        targetWord: room.targetWord,
        players: room.players,
        roomCode: roomCode
      });

      // Notify the room creator that a player has joined
      socket.to(roomCode).emit('playerJoined', {
        playerId: socket.id
      });

      // Mark the joining player as ready
      room.readyPlayers.add(socket.id);
      
      // Notify all players about ready state
      io.to(roomCode).emit('playerReady', {
        playerId: socket.id,
        readyCount: room.readyPlayers.size
      });

      console.log(`\n👥 Ready players in room ${roomCode}:`, Array.from(room.readyPlayers));
      console.log(`Total players: ${room.players.length}, Ready players: ${room.readyPlayers.size}`);

      // If both players are ready, start the game
      if (room.players.length === 2 && room.readyPlayers.size === 2) {
        // Update room status
        room.status = 'playing';
        console.log(`\n🎲 Starting game in room ${roomCode}`);
        console.log(`Target word: ${room.targetWord}`);
        console.log(`Players: ${room.players.join(', ')}`);

        // Emit game start to all players in the room
        io.to(roomCode).emit('gameStart', {
          targetWord: room.targetWord,
          players: room.players,
          roomCode: roomCode
        });
        
        console.log(`\n🎯 Game started in room ${roomCode}`);
        logRoomStatus(roomCode, 'Game Started');
      } else {
        console.log(`\n⏳ Waiting for all players to be ready in room ${roomCode}`);
        console.log(`Players ready: ${room.readyPlayers.size}/${room.players.length}`);
      }

    } catch (error) {
      console.error('❌ Error joining room:', error);
      callback({ success: false, error: 'Failed to join room' });
    }
  });

  socket.on('ready', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (room && room.players.includes(socket.id)) {
      room.readyPlayers.add(socket.id);
      
      io.to(roomCode).emit('playerReady', {
        playerId: socket.id,
        readyCount: room.readyPlayers.size
      });

      // If both players are ready, start the game
      if (room.players.length === 2 && room.readyPlayers.size === 2) {
        // Update room status
        room.status = 'playing';
        console.log(`\n🎲 Starting game in room ${roomCode}`);
        console.log(`Target word: ${room.targetWord}`);
        console.log(`