# ProxiSpeak Database Setup
## 1. Technology
ProxiSpeak uses MongoDB with Mongoose. The database connection is configured in `src/config/db.js`, and `src/index.js` loads environment variables with `dotenv` before connecting.
## 2. Environment configuration
Create a `.env` file inside the `server` directory:
```env
MONGODB_URI=mongodb://127.0.0.1:27017/proxispeak
PORT=5000
```
Use your own approved MongoDB connection URI when connecting to a hosted database. Never commit `.env` or credentials.
Install dependencies with `npm install` and start the backend with `npm.cmd start` in PowerShell. MongoDB must be available at the configured URI.
## 3. Collections and fields
### users
Model: `src/models/User.js`
- `userId`: required, unique user identifier (String).
- `username`: required display name (String).
- `createdAt`, `updatedAt`: Mongoose timestamps.
### worlds
Model: `src/models/World.js`
Stores world records, including identity, name, owner identifier, layout, and configured timestamps.
### worldmembers
Model: `src/models/WorldMember.js`
Links application user IDs to world ObjectIds and stores membership roles.
### communicationsessions
Model: `src/models/CommunicationSession.js`
- `participantIds`: at least two unique user IDs.
- `worldId`: optional reference to a World document.
- `status`: `active` or `ended`.
- `startedAt`, `endedAt`: session lifecycle timestamps.
- `createdAt`, `updatedAt`: Mongoose timestamps.
Indexes support queries by participant/status and world/status.
## 4. Relationships
- World membership links a user's `userId` to a World ObjectId.
- A communication session stores participant user IDs and can optionally link to a world.
- `participantIds` stores application-level user IDs, not MongoDB User `_id` values.
- Mongoose references do not automatically enforce referential integrity.
## 5. Connection and verification
`src/config/db.js` reads `MONGODB_URI` from the environment and reports an error if it is missing. The application calls `connectDB()` during startup.
Run `npm.cmd start` from the `server` directory with MongoDB available. Check the health endpoint at `http://localhost:5000/api/health`.
Adding this model does not automatically create session documents or integrate persistence with the existing Socket.IO communication flow.
