const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { words } = require('./utils/wordle-list.json');

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active game rooms
const gameRooms = new Map();

// Generate a random room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Select a random word for the game
function getRandomWord() {
  return words[Math.floor(Math.random() * words.length)].toUpperCase();
}

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Handle create room request
  socket.on('createRoom', (callback) => {
    try {
      console.log('Creating new room for client:', socket.id);
      const roomCode = generateRoomCode();
      const targetWord = getRandomWord();
      
      gameRooms.set(roomCode, {
        players: [socket.id],
        targetWord,
        status: 'waiting',
        guesses: new Map()
      });

      socket.join(roomCode);
      socket.roomCode = roomCode;
      
      console.log('Room created:', roomCode);
      socket.emit('roomCreated', { roomCode });
      
      if (typeof callback === 'function') {
        callback({ success: true, roomCode });
      }
    } catch (error) {
      console.error('Error creating room:', error);
      if (typeof callback === 'function') {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Handle join room request
  socket.on('joinRoom', ({ roomCode }, callback) => {
    try {
      console.log('Join request for room:', roomCode);
      const room = gameRooms.get(roomCode);
      
      if (!room) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'Room not found' });
        }
        return;
      }

      if (room.players.length >= 2) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'Room is full' });
        }
        return;
      }

      room.players.push(socket.id);
      socket.join(roomCode);
      socket.roomCode = roomCode;

      if (room.players.length === 2) {
        room.status = 'playing';
        io.to(roomCode).emit('gameStart', { 
          targetWord: room.targetWord,
          players: room.players,
          roomCode: roomCode
        });

        if (typeof callback === 'function') {
          callback({ 
            success: true, 
            gameStarting: true,
            targetWord: room.targetWord,
            players: room.players,
            roomCode: roomCode
          });
        }
      } else {
        socket.emit('waitingForPlayer');
        if (typeof callback === 'function') {
          callback({ success: true, gameStarting: false });
        }
      }
    } catch (error) {
      console.error('Error joining room:', error);
      if (typeof callback === 'function') {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Handle player guess
  socket.on('makeGuess', ({ roomCode, guess }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.status !== 'playing') return;

    const playerNumber = room.players.indexOf(socket.id) + 1;
    
    if (!room.guesses.has(socket.id)) {
      room.guesses.set(socket.id, []);
    }
    
    const playerGuesses = room.guesses.get(socket.id);
    playerGuesses.push(guess);

    io.to(roomCode).emit('guessUpdate', {
      playerId: socket.id,
      guess: guess
    });

    const isCorrect = guess.toUpperCase() === room.targetWord;
    if (isCorrect) {
      room.status = 'finished';
      io.to(roomCode).emit('gameOver', {
        winner: socket.id,
        winnerNumber: playerNumber,
        targetWord: room.targetWord
      });
      setTimeout(() => gameRooms.delete(roomCode), 5000);
    } else if (playerGuesses.length >= 6) {
      const otherPlayer = room.players.find(id => id !== socket.id);
      const otherPlayerGuesses = room.guesses.get(otherPlayer) || [];
      
      if (otherPlayerGuesses.length >= 6) {
        room.status = 'finished';
        io.to(roomCode).emit('gameOver', {
          winner: null,
          targetWord: room.targetWord,
          isDraw: true
        });
        setTimeout(() => gameRooms.delete(roomCode), 5000);
      }
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const roomCode = socket.roomCode;
    if (roomCode) {
      const room = gameRooms.get(roomCode);
      if (room) {
        io.to(roomCode).emit('playerLeft', { playerId: socket.id });
        gameRooms.delete(roomCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 