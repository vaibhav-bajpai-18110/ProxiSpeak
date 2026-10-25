# ProxiSpeak Database Setup

## 1. Technology

ProxiSpeak uses MongoDB with Mongoose. The database connection is configured in `src/config/db.js`, and `src/index.js` loads environment variables with `dotenv` before connecting.

## 2. Environment Configuration

Create a `.env` file inside the `server` directory using the following local-development settings:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/proxispeak
PORT=5000
```

The same variable names are provided in `.env.example`.

- `MONGODB_URI`: MongoDB connection URI.
- `PORT`: backend server port.

For a hosted database, use the approved connection URI supplied for your environment. Never commit `.env` files, passwords, or other credentials.

Install dependencies and start the backend from the `server` directory:

```powershell
npm install
npm.cmd start
```

MongoDB must be available at the configured URI.

## 3. Collections and Schemas

### 3.1 Users

Model: `src/models/User.js`

Collection: `users`

- `userId`: required, unique String identifier; whitespace is trimmed.
- `username`: required String display name; whitespace is trimmed.
- `createdAt`, `updatedAt`: automatically maintained by Mongoose timestamps.

### 3.2 Worlds

Model: `src/models/World.js`

Collection: `worlds`

- `name`: required String; whitespace is trimmed.
- `ownerId`: required String identifying the owner; whitespace is trimmed.
- `layout`: flexible Mixed data field; defaults to an empty object.
- `createdAt`, `updatedAt`: automatically maintained by Mongoose timestamps.

### 3.3 World Members

Model: `src/models/WorldMember.js`

Collection: `worldmembers`

- `userId`: required String application-level user ID; whitespace is trimmed.
- `worldId`: required MongoDB ObjectId reference to a `World` document.
- `role`: String restricted to `owner` or `member`; defaults to `member`.
- `createdAt`, `updatedAt`: automatically maintained by Mongoose timestamps.
- Unique compound index on `{ userId: 1, worldId: 1 }` prevents duplicate membership records for the same user and world.

### 3.4 Communication Sessions

Model: `src/models/CommunicationSession.js`

Collection: `communicationsessions`

- `participantIds`: required array of String IDs. Validation requires at least two nonblank, unique participant IDs.
- `worldId`: optional ObjectId reference to a `World` document; defaults to `null`.
- `status`: required String restricted to `active` or `ended`; defaults to `active`.
- `startedAt`: required Date; defaults to the current time.
- `endedAt`: Date; defaults to `null`.
- `createdAt`, `updatedAt`: automatically maintained by Mongoose timestamps.
- Index on `{ participantIds: 1, status: 1 }` supports queries by participant and status.
- Index on `{ worldId: 1, status: 1 }` supports queries by world and status.

## 4. Relationships and Identifier Conventions

- A world stores its owner in `ownerId`, an application-level String identifier.
- A world membership connects an application-level `userId` to a MongoDB `World` ObjectId.
- A communication session stores participant IDs as application-level Strings and can optionally reference a world by ObjectId.
- `participantIds` and `WorldMember.userId` are not MongoDB `User._id` values.
- Mongoose references describe relationships but do not automatically guarantee that every referenced document exists.

## 5. Database Connection and Verification

The connection helper in `src/config/db.js` reads `MONGODB_URI` from the environment and throws an error if the variable is missing. The application connects to MongoDB during startup before the server begins listening.

Start the backend from the `server` directory with MongoDB available, then check the health endpoint:

```text
http://localhost:5000/api/health
```

The Socket.IO integration verification is documented separately in `DAY9_VERIFICATION.md` and can be run using:

```powershell
node .\day9-integration-check.js
```

Keep the database schema documentation and integration-test results up to date when the models or session lifecycle behavior change.
