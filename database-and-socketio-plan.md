ProxiSpeak – Database and Socket.IO Plan

1. Project Overview

ProxiSpeak is a geospatial proximity audio ecosystem where users interact through avatars in a shared virtual world and communicate with nearby users.

2. MongoDB Database Design

Database name: "proxispeak"

Collection 1: users

Purpose: Store user profile information.

- "_id": Unique user identifier
- "displayName": Name shown to other users
- "avatar": Avatar details
- "createdAt": Account creation timestamp

Collection 2: worlds

Purpose: Store virtual world information.

- "_id": Unique world identifier
- "name": World name
- "ownerId": ID of the world owner
- "layout": World layout data
- "createdAt": Creation timestamp

Collection 3: worldMembers

Purpose: Track users who belong to a world.

- "userId": User identifier
- "worldId": World identifier
- "role": User's role in that world

3. Socket.IO Event Plan

Event| Direction| Purpose
"join-world"| Client → Server| Request to join a world
"world-joined"| Server → Client| Confirm successful entry
"user-joined"| Server → Clients| Notify other users when someone joins
"avatar-move"| Client → Server| Send avatar position updates
"user-moved"| Server → Clients| Broadcast movement to other users
"user-left"| Server → Clients| Notify users when someone leaves

4. Data Handling

- MongoDB stores persistent user profiles and virtual world information.
- Socket.IO handles real-time events and avatar movement.
- WebRTC can be used for live audio communication.
- Frequently changing avatar positions should generally be handled by Socket.IO rather than stored in MongoDB on every movement.

5. Coordination and Next Steps

- Confirm collection structures with the backend developer.
- Confirm event names and payload formats with the backend developer.
- Configure MongoDB connection settings securely.
- Test database operations before integrating with the application.