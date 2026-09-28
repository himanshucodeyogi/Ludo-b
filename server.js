import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 4000;

// ==========================================
// LUDO CONSTANTS & RULES
// ==========================================
export const PLAYER_COLORS = ['red', 'green', 'yellow', 'blue'];

// Active colors based on room capacity
export const ROOM_COLOR_SCHEMES = {
  2: ['red', 'yellow'],                 // Opposite corners for balanced 2-player Ludo
  3: ['red', 'green', 'yellow'],        // 3 players
  4: ['red', 'green', 'yellow', 'blue'] // 4 players
};

export const START_TILES = {
  red: 0,
  green: 13,
  yellow: 26,
  blue: 39
};

// Safe indices on the 52-tile circuit
export const SAFE_CIRCUIT_TILES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// In-memory rooms
const rooms = new Map();

/**
 * Generates an easy-to-type 5-character alphanumeric room code
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

/**
 * Returns the global circuit tile index (0..51) for a token's step (0..50)
 */
function getGlobalCircuitTile(color, step) {
  if (step < 0 || step > 50) return null;
  return (START_TILES[color] + step) % 52;
}

/**
 * Checks which tokens can legally move for the current roll
 */
function getValidMoves(colorTokens, roll) {
  const validIndices = [];
  colorTokens.forEach((step, index) => {
    if (step === -1) {
      if (roll === 6) validIndices.push(index); // 6 needed to unlock from base
    } else if (step >= 0 && step < 56) {
      if (step + roll <= 56) {
        validIndices.push(index); // Must land exactly on or before 56 (Home)
      }
    }
  });
  return validIndices;
}

/**
 * Advances the turn to the next active player
 */
function advanceTurn(room) {
  if (room.autoMoveTimer) {
    clearTimeout(room.autoMoveTimer);
    room.autoMoveTimer = null;
  }
  room.diceValue = null;
  room.diceRolled = false;
  room.validMoves = [];
  room.consecutiveSixes = 0;

  const activePlayers = room.players.filter((p) => !p.hasWon);
  if (activePlayers.length <= 1) {
    if (activePlayers.length === 1 && !room.winner) {
      room.winner = activePlayers[0].color;
    }
    return;
  }

  let nextIndex = (room.currentTurnIndex + 1) % room.players.length;
  // Skip players who have already won
  while (room.players[nextIndex].hasWon) {
    nextIndex = (nextIndex + 1) % room.players.length;
  }

  room.currentTurnIndex = nextIndex;
  triggerBotOrDisconnectedTurn(room);
}

/**
 * If the current turn belongs to a disconnected player or bot, play automatically
 */
function triggerBotOrDisconnectedTurn(room) {
  const currentPlayer = room.players[room.currentTurnIndex];
  if (!currentPlayer || room.winner || !room.gameStarted) return;

  if (!currentPlayer.isConnected || currentPlayer.isBot) {
    setTimeout(() => {
      if (room.currentTurnIndex !== room.players.indexOf(currentPlayer)) return;
      if (currentPlayer.isConnected && !currentPlayer.isBot) return; // Player reconnected meanwhile
      handleDiceRoll(room.id, currentPlayer.socketId || currentPlayer.id, true);
    }, 1500);
  }
}

/**
 * Rolls the dice on behalf of a player or bot
 */
function handleDiceRoll(roomId, actorId, isAutomated = false) {
  const room = rooms.get(roomId);
  if (!room || !room.gameStarted || room.winner) return;

  const currentPlayer = room.players[room.currentTurnIndex];
  if (!currentPlayer) return;

  // Verify actor authority (unless automated bot/disconnect takeover)
  if (!isAutomated && currentPlayer.socketId !== actorId) {
    return;
  }

  if (room.diceRolled) return; // Prevent double rolling

  const roll = Math.floor(Math.random() * 6) + 1;
  room.diceValue = roll;
  room.diceRolled = true;

  if (roll === 6) {
    room.consecutiveSixes = (room.consecutiveSixes || 0) + 1;
  } else {
    room.consecutiveSixes = 0;
  }

  // Rule: 3 consecutive sixes voids turn and passes to next player
  if (room.consecutiveSixes === 3) {
    io.to(roomId).emit('dice_rolled', {
      diceValue: roll,
      color: currentPlayer.color,
      consecutiveSixesPenalty: true
    });
    io.to(roomId).emit('game_state_update', getPublicRoomState(room));
    setTimeout(() => {
      advanceTurn(room);
      io.to(roomId).emit('game_state_update', getPublicRoomState(room));
    }, 1500);
    return;
  }

  const validMoves = getValidMoves(room.tokens[currentPlayer.color], roll);
  room.validMoves = validMoves;

  io.to(roomId).emit('dice_rolled', {
    diceValue: roll,
    color: currentPlayer.color,
    validMoves
  });

  // Broadcast updated game state immediately so all clients see the roll & movable pawns
  io.to(roomId).emit('game_state_update', getPublicRoomState(room));

  // If no valid moves exist, notify and pass turn after 1.5s
  if (validMoves.length === 0) {
    setTimeout(() => {
      advanceTurn(room);
      io.to(roomId).emit('game_state_update', getPublicRoomState(room));
    }, 1500);
    return;
  }

  // Clear any existing move timer
  if (room.autoMoveTimer) {
    clearTimeout(room.autoMoveTimer);
    room.autoMoveTimer = null;
  }

  // Safety / Bot auto-move timer:
  // Bots move after 1.2s; human players have 7s before auto-moving so the game never freezes
  const isBotOrDisconnected = !currentPlayer.isConnected || currentPlayer.isBot;
  const autoMoveDelay = isBotOrDisconnected ? 1200 : 7000;

  room.autoMoveTimer = setTimeout(() => {
    if (!room.diceRolled || room.winner || room.validMoves.length === 0) return;
    let chosenToken = validMoves[0];
    for (const tokenIdx of validMoves) {
      const curStep = room.tokens[currentPlayer.color][tokenIdx];
      if (curStep === -1 && roll === 6) {
        chosenToken = tokenIdx;
        break;
      }
    }
    handleTokenMove(roomId, currentPlayer.socketId || currentPlayer.id, chosenToken, true);
  }, autoMoveDelay);
}

/**
 * Handles moving a token
 */
function handleTokenMove(roomId, actorId, tokenIndex, isAutomated = false) {
  const room = rooms.get(roomId);
  if (!room || !room.gameStarted || room.winner || !room.diceRolled) return;

  const currentPlayer = room.players[room.currentTurnIndex];
  if (!currentPlayer) return;

  if (!isAutomated && currentPlayer.socketId !== actorId) {
    return;
  }

  if (!room.validMoves.includes(tokenIndex)) {
    return;
  }

  if (room.autoMoveTimer) {
    clearTimeout(room.autoMoveTimer);
    room.autoMoveTimer = null;
  }

  const color = currentPlayer.color;
  const currentStep = room.tokens[color][tokenIndex];
  const roll = room.diceValue;

  let newStep = currentStep;
  if (currentStep === -1) {
    if (roll === 6) newStep = 0;
  } else {
    newStep = currentStep + roll;
  }

  room.tokens[color][tokenIndex] = newStep;

  let capturedOpponent = null;
  let bonusTurn = roll === 6;

  // Check for capturing an opponent
  if (newStep >= 0 && newStep <= 50) {
    const globalTile = getGlobalCircuitTile(color, newStep);
    if (!SAFE_CIRCUIT_TILES.has(globalTile)) {
      // Find any opponent token on this tile
      for (const otherPlayer of room.players) {
        if (otherPlayer.color === color) continue;

        room.tokens[otherPlayer.color].forEach((oppStep, oppIdx) => {
          if (oppStep >= 0 && oppStep <= 50) {
            const oppGlobalTile = getGlobalCircuitTile(otherPlayer.color, oppStep);
            if (oppGlobalTile === globalTile) {
              // Capture opponent!
              room.tokens[otherPlayer.color][oppIdx] = -1;
              capturedOpponent = {
                color: otherPlayer.color,
                tokenIndex: oppIdx
              };
              bonusTurn = true; // Bonus turn for capture!
            }
          }
        });
      }
    }
  }

  // Check if token reached Home (56)
  if (newStep === 56) {
    bonusTurn = true;
    const allHome = room.tokens[color].every((s) => s === 56);
    if (allHome) {
      currentPlayer.hasWon = true;
      room.winner = color;
      io.to(roomId).emit('player_won', { color, player: currentPlayer });
    }
  }

  io.to(roomId).emit('token_moved', {
    color,
    tokenIndex,
    previousStep: currentStep,
    newStep,
    capturedOpponent,
    bonusTurn
  });

  if (room.winner) {
    io.to(roomId).emit('game_state_update', getPublicRoomState(room));
    return;
  }

  // Turn continuation or pass
  if (bonusTurn) {
    room.diceValue = null;
    room.diceRolled = false;
    room.validMoves = [];
    io.to(roomId).emit('game_state_update', getPublicRoomState(room));
    triggerBotOrDisconnectedTurn(room);
  } else {
    advanceTurn(room);
    io.to(roomId).emit('game_state_update', getPublicRoomState(room));
  }
}

/**
 * Returns the room for a player action, or tells the client why its action can't apply
 * (instead of silently ignoring it and leaving the client stuck on a stale view)
 */
function getActionRoom(socket, roomId, callback) {
  const room = rooms.get(roomId);
  if (!room) {
    if (callback) callback({ success: false, code: 'ROOM_NOT_FOUND' });
    return null;
  }
  if (!room.players.some((p) => p.socketId === socket.id)) {
    if (callback) callback({ success: false, code: 'NOT_IN_ROOM' });
    return null;
  }
  return room;
}

/**
 * Strips server-only fields (socketId, sessionToken) from a player
 */
function toPublicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    isHost: p.isHost,
    isBot: p.isBot,
    isConnected: p.isConnected,
    hasWon: p.hasWon
  };
}

/**
 * Filtered room state for public broadcast
 */
function getPublicRoomState(room) {
  return {
    roomId: room.id,
    maxPlayers: room.maxPlayers,
    colorScheme: room.colorScheme || ROOM_COLOR_SCHEMES[room.maxPlayers] || ROOM_COLOR_SCHEMES[4],
    players: room.players.map(toPublicPlayer),
    currentTurnColor: room.players[room.currentTurnIndex]?.color || null,
    currentTurnIndex: room.currentTurnIndex,
    diceValue: room.diceValue,
    diceRolled: room.diceRolled,
    validMoves: room.validMoves,
    tokens: room.tokens,
    gameStarted: room.gameStarted,
    winner: room.winner
  };
}

// ==========================================
// SOCKET.IO REAL-TIME EVENT HANDLERS
// ==========================================
io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Create Room
  socket.on('create_room', ({ playerName, maxPlayers = 4 }, callback) => {
    const roomId = generateRoomCode();
    const targetMax = Math.min(Math.max(Number(maxPlayers) || 4, 2), 4);
    const scheme = ROOM_COLOR_SCHEMES[targetMax] || ROOM_COLOR_SCHEMES[4];

    const newPlayer = {
      id: socket.id,
      socketId: socket.id,
      sessionToken: randomUUID(),
      name: playerName || 'Host Player',
      color: scheme[0], // First color (Red)
      isHost: true,
      isBot: false,
      isConnected: true,
      hasWon: false
    };

    // ONLY initialize tokens for active colors in this game mode
    const initialTokens = {};
    scheme.forEach((c) => {
      initialTokens[c] = [-1, -1, -1, -1];
    });

    const room = {
      id: roomId,
      maxPlayers: targetMax,
      colorScheme: scheme,
      players: [newPlayer],
      currentTurnIndex: 0,
      diceValue: null,
      diceRolled: false,
      validMoves: [],
      consecutiveSixes: 0,
      gameStarted: false,
      winner: null,
      tokens: initialTokens
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerColor = newPlayer.color;

    if (callback) {
      callback({ success: true, roomId, player: toPublicPlayer(newPlayer), sessionToken: newPlayer.sessionToken });
    }
    io.to(roomId).emit('game_state_update', getPublicRoomState(room));
  });

  // Join Room
  socket.on('join_room', ({ roomId, playerName }, callback) => {
    const normalizedId = roomId ? roomId.trim().toUpperCase() : '';
    const room = rooms.get(normalizedId);

    if (!room) {
      if (callback) callback({ success: false, message: 'Room not found.' });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      if (callback) callback({ success: false, message: 'Room is already full.' });
      return;
    }

    if (room.gameStarted) {
      if (callback) callback({ success: false, message: 'Game already in progress.' });
      return;
    }

    const scheme = room.colorScheme || ROOM_COLOR_SCHEMES[room.maxPlayers] || ROOM_COLOR_SCHEMES[4];
    const assignedColor = scheme[room.players.length];
    const newPlayer = {
      id: socket.id,
      socketId: socket.id,
      sessionToken: randomUUID(),
      name: playerName || `Player ${room.players.length + 1}`,
      color: assignedColor,
      isHost: false,
      isBot: false,
      isConnected: true,
      hasWon: false
    };

    room.players.push(newPlayer);
    socket.join(normalizedId);
    socket.data.roomId = normalizedId;
    socket.data.playerColor = assignedColor;

    if (callback) {
      callback({
        success: true,
        roomId: normalizedId,
        player: toPublicPlayer(newPlayer),
        sessionToken: newPlayer.sessionToken
      });
    }
    io.to(normalizedId).emit('player_joined', { player: toPublicPlayer(newPlayer) });
    io.to(normalizedId).emit('game_state_update', getPublicRoomState(room));
  });

  // Rejoin Room (after a dropped connection or page refresh)
  socket.on('rejoin_room', ({ roomId, sessionToken } = {}, callback) => {
    const room = rooms.get(typeof roomId === 'string' ? roomId : '');
    const player = room && sessionToken && room.players.find((p) => p.sessionToken === sessionToken);

    if (!player) {
      if (callback) callback({ success: false, message: 'Room no longer exists.' });
      return;
    }

    player.socketId = socket.id;
    player.isConnected = true;
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerColor = player.color;

    if (callback) callback({ success: true, roomId: room.id, player: toPublicPlayer(player) });
    socket.to(room.id).emit('player_reconnected', { color: player.color, name: player.name });
    io.to(room.id).emit('game_state_update', getPublicRoomState(room));
  });

  // Start Game
  socket.on('start_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameStarted) return;

    const scheme = room.colorScheme || ROOM_COLOR_SCHEMES[room.maxPlayers] || ROOM_COLOR_SCHEMES[4];

    // Fill remaining empty slots with friendly bots only up to maxPlayers
    while (room.players.length < room.maxPlayers) {
      const botColor = scheme[room.players.length];
      room.players.push({
        id: `bot_${botColor}`,
        socketId: null,
        name: `Bot (${botColor.toUpperCase()})`,
        color: botColor,
        isHost: false,
        isBot: true,
        isConnected: true,
        hasWon: false
      });
    }

    room.gameStarted = true;
    room.currentTurnIndex = 0;
    room.winner = null;

    io.to(roomId).emit('game_started', getPublicRoomState(room));
    io.to(roomId).emit('game_state_update', getPublicRoomState(room));

    triggerBotOrDisconnectedTurn(room);
  });

  // Roll Dice
  socket.on('roll_dice', ({ roomId } = {}, callback) => {
    const room = getActionRoom(socket, roomId, callback);
    if (!room) return;
    handleDiceRoll(roomId, socket.id);
    // If the roll was rejected (not your turn / already rolled) the sender's view is stale: resync it
    socket.emit('game_state_update', getPublicRoomState(room));
    if (callback) callback({ success: true });
  });

  // Move Token
  socket.on('move_token', ({ roomId, tokenIndex } = {}, callback) => {
    const room = getActionRoom(socket, roomId, callback);
    if (!room) return;
    handleTokenMove(roomId, socket.id, tokenIndex);
    socket.emit('game_state_update', getPublicRoomState(room));
    if (callback) callback({ success: true });
  });

  // Reset Game / Rematch
  socket.on('restart_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const scheme = room.colorScheme || ROOM_COLOR_SCHEMES[room.maxPlayers] || ROOM_COLOR_SCHEMES[4];
    room.gameStarted = true;
    room.currentTurnIndex = 0;
    room.diceValue = null;
    room.diceRolled = false;
    room.validMoves = [];
    room.winner = null;

    const resetTokens = {};
    scheme.forEach((c) => {
      resetTokens[c] = [-1, -1, -1, -1];
    });
    room.tokens = resetTokens;
    room.players.forEach((p) => (p.hasWon = false));

    io.to(roomId).emit('game_state_update', getPublicRoomState(room));
    triggerBotOrDisconnectedTurn(room);
  });

  // Disconnect Handling
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player) {
      player.isConnected = false;
      player.socketId = null;

      io.to(roomId).emit('player_disconnected', { color: player.color, name: player.name });
      io.to(roomId).emit('game_state_update', getPublicRoomState(room));

      // If it was this player's turn, trigger bot takeover
      if (room.gameStarted && room.players[room.currentTurnIndex] === player) {
        triggerBotOrDisconnectedTurn(room);
      }
    }

    // Clean up empty room after all real players leave
    const hasConnectedHuman = room.players.some((p) => p.isConnected && !p.isBot);
    if (!hasConnectedHuman) {
      setTimeout(() => {
        const checkRoom = rooms.get(roomId);
        if (checkRoom && !checkRoom.players.some((p) => p.isConnected && !p.isBot)) {
          rooms.delete(roomId);
          console.log(`[Room Deleted] Inactive Room: ${roomId}`);
        }
      }, 30000);
    }
  });
});

// Log unexpected errors instead of letting one bad event kill every room in memory
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]', err));
process.on('unhandledRejection', (err) => console.error('[Unhandled Rejection]', err));

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', activeRooms: rooms.size });
});

// On Vercel the exported server is invoked by the platform; locally we listen ourselves
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`🎲 Ludo 3D Multiplayer Server running on port ${PORT}`);
  });
}

export default server;
