# 🎲 Ludo 3D - Authoritative Multiplayer Backend

High-performance real-time multiplayer backend server for the 3D Ludo game, built with **Node.js**, **Express**, and **Socket.io**.

---

## 🚀 Key Features

- **Authoritative Rule Engine**: Enforces legal moves, roll validation, safe star zones, pawn capturing, and victory detection on the server.
- **Dynamic Player Scaling**: Supports matches with 2, 3, or 4 players with matching token configurations (8, 12, or 16 pawns).
- **Socket.io Real-Time Synchronization**: Instant state synchronization for dice rolls, token kinematics, turn transitions, and player joins/disconnects.
- **Bot Takeover & Disconnect Handling**: Automatically passes turns or activates intelligent AI bot moves if a player disconnects or is inactive.
- **Real-Time Broadcasts**: Emits `token_moved` with previous and new tile indices to synchronize 3D character arm inverse kinematics across all connected players.

---

## 🛠️ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Development Server
```bash
npm run dev
```

### 3. Run Production Server
```bash
npm start
```

The server listens on port **4000** by default (or the `PORT` environment variable).

---

## 📡 API & Health Check

- **GET `/health`**: Returns server status and number of active game rooms.
  ```json
  {
    "status": "healthy",
    "activeRooms": 1
  }
  ```

---

## 🌐 WebSocket Events (Socket.io)

### Client ➡️ Server
- `create_room` - Creates a new game room with custom player count (2, 3, or 4)
- `join_room` - Joins an existing room using room code
- `rejoin_room` - Reclaims a seat after a reconnect/refresh using the `sessionToken` returned on create/join
- `start_game` - Host starts the match
- `roll_dice` - Requests authoritative server dice roll
- `move_token` - Moves selected token index
- `restart_game` - Resets game for rematch

### Server ➡️ Client
- `room_created` / `room_joined` - Confirms player entry
- `game_state_update` - Full room state synchronization
- `dice_rolled` - Roll result, valid moves, and penalties
- `token_moved` - Broadcasts moving token index, previousStep, newStep, and captures
- `player_won` - Declares winner
- `player_disconnected` / `player_reconnected` - Seat went offline (AI takes over) / came back

---

## ☁️ Deploying to Render

Rooms and turn timers live in server memory, so the backend needs a single, always-on Node process (serverless platforms like Vercel drop connections and lose rooms). `render.yaml` in this folder is a Render Blueprint for that.

1. Push this backend to its GitHub repo (the `render.yaml` must be at the repo root).
2. In the Render dashboard: **New → Blueprint**, pick the repo, and apply. It creates the `ludo-backend` web service (`npm ci` → `npm start`, health check `/health`).
3. Once live, open `https://<your-service>.onrender.com/health` — it should return `{"status":"healthy",...}`.
4. In the **frontend** deployment, set `VITE_BACKEND_URL=https://<your-service>.onrender.com` and redeploy (Vite bakes it in at build time).

Keep the service at **one instance**. On the free plan the service sleeps after ~15 min without traffic, so the first connection after that takes ~30-60s, and any rooms in progress are lost when it sleeps or redeploys.
