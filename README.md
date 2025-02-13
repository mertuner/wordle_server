# Wordle Multiplayer Server

Backend server for the multiplayer Wordle game with competitive ranking system.

## Features

- Real-time multiplayer gameplay
- ELO-based ranking system
- Player statistics tracking
- Global leaderboard
- Private game rooms
- Quick matchmaking

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set up Firebase:
   - Create a Firebase project at [Firebase Console](https://console.firebase.google.com)
   - Go to Project Settings > Service Accounts
   - Generate a new private key
   - Create a `.env` file based on `.env.example`
   - Add your Firebase service account credentials to the `.env` file

3. Start the server:
```bash
# Development
npm run dev

# Production
npm run prod
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

- `PORT`: Server port (default: 3001)
- `NODE_ENV`: Environment (development/production)
- `CLIENT_URL_LOCAL`: Local client URL
- `CLIENT_URL_PROD`: Production client URL
- `FIREBASE_SERVICE_ACCOUNT`: Your Firebase service account credentials (as a JSON string)

## API Endpoints

- `GET /health`: Server health check
- `GET /leaderboard`: Get global player rankings
- `GET /stats/:userId`: Get player statistics

## WebSocket Events

### Client to Server
- `authenticate`: Player authentication
- `joinMatchmaking`: Join quick match queue
- `createRoom`: Create private room
- `joinRoom`: Join existing room
- `makeGuess`: Submit word guess
- `leaveMatchmaking`: Leave match queue

### Server to Client
- `authenticated`: Authentication success with player stats
- `gameStart`: Game started with target word
- `guessUpdate`: Player guess result
- `gameOver`: Game ended with winner
- `statsUpdate`: Updated player statistics
- `error`: Error message

## Security

⚠️ Important: Never commit your Firebase credentials or any sensitive information to version control. The `.env` file is ignored by git for this reason. 