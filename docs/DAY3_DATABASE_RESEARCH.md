Day 3 — Database and Real-Time Research

ProxiSpeak Internship Project

Role: Member 3 — Database and Real-Time Research

1. Introduction

ProxiSpeak is a geospatial proximity audio application where users interact through avatars in a shared virtual world and communicate with nearby users.

The application needs to store user and world information and support real-time events such as joining a world and moving an avatar.

MongoDB and Socket.IO can support these requirements. MongoDB stores persistent application data, while Socket.IO enables real-time communication between clients and the server.

2. MongoDB Basics

MongoDB is a NoSQL document database. It stores data in flexible, JSON-like documents using BSON, a binary representation of JSON that supports additional data types.

Important concepts

- Database: A container for collections.
- Collection: A group of related documents, similar to a table in a relational database.
- Document: A record containing fields and values.
- "_id": A unique identifier for each document, automatically generated if not supplied.
- CRUD: Create, Read, Update, and Delete operations used to manage data.

Example MongoDB document for a ProxiSpeak user:

{
  "_id": "user123",
  "displayName": "Aman",
  "avatar": {
    "model": "avatar1"
  },
  "createdAt": "2026-10-18T10:00:00Z"
}

This document stores a user's profile information. In a real implementation, the application should use an appropriate identifier type and validate the document structure.

3. MongoDB's Role in ProxiSpeak

MongoDB can store information that needs to remain available after a user disconnects or the server restarts.

The proposed database is named "proxispeak".

Proposed collections

Collection| Purpose
"users"| Stores user profiles, display names, avatar information, and account creation time.
"worlds"| Stores virtual world details, ownership, layout, and creation time.
"worldMembers"| Records which users belong to which worlds and their roles.

A "worldMembers" document could contain:

{
  "userId": "user123",
  "worldId": "world456",
  "role": "member"
}

The "userId" and "worldId" fields connect membership records to users and worlds. The backend should validate these references and consider an index on the pair to prevent duplicate memberships.

Data that belongs in MongoDB

MongoDB is suitable for relatively persistent information such as:

- User profiles and avatar preferences.
- World names, ownership, and layouts.
- Membership and role information.
- Other application data that must survive disconnections.

Frequently changing avatar coordinates do not necessarily need to be saved to MongoDB on every movement. Their storage requirements should be decided based on product needs, such as whether the application must restore a user's last position.

4. Socket.IO Basics

Socket.IO is a library for real-time, bidirectional communication between a client and a server.

It commonly uses WebSocket when available and can fall back to HTTP long-polling. It provides features such as event-based messaging, reconnection, and rooms.

Important concepts

- Client: The application connected to the server.
- Server: Receives, validates, and distributes events.
- Event: A named message that carries information or requests an action.
- Room: A group of connected sockets that can receive relevant broadcasts.
- Emit: Send an event to another endpoint or group of clients.

For ProxiSpeak, a room can represent a virtual world. Users in the same world can receive relevant avatar movement and membership notifications without broadcasting those events to every connected user.

5. Socket.IO's Role in ProxiSpeak

Socket.IO can handle real-time updates while users interact in a shared world.

The planned events are:

Event| Direction| Purpose
"join-world"| Client → Server| Request to enter a world.
"world-joined"| Server → Client| Confirm that the user joined successfully.
"user-joined"| Server → Clients| Notify other members about a new user.
"avatar-move"| Client → Server| Send an avatar's position update.
"user-moved"| Server → Clients| Broadcast validated movement to other members.
"user-left"| Server → Clients| Notify members when a user leaves.

The server should authenticate the user, check world membership and permissions, validate movement data, and send updates only to authorized recipients.

Movement events should also be rate-limited or throttled as appropriate to reduce unnecessary network traffic.

6. How MongoDB and Socket.IO Work Together

MongoDB and Socket.IO have different responsibilities but can work together in the ProxiSpeak backend.

A typical world-joining flow is:

1. A client sends a "join-world" event to the server.
2. The server verifies the user's identity and checks the requested world and membership.
3. The server retrieves necessary persistent information from MongoDB.
4. If permitted, the server joins the client's socket to the corresponding Socket.IO room.
5. The server sends "world-joined" to that client and broadcasts "user-joined" to other relevant members.

For avatar movement:

1. The client sends an "avatar-move" event.
2. The server validates the position and confirms that the client is authorized to move in that world.
3. The server broadcasts a "user-moved" event to the relevant room.
4. Other clients update the moving avatar on their screens.

This approach separates persistent data storage from real-time message delivery.

7. Real-Time Audio and WebRTC

Socket.IO can exchange signaling information needed to establish an audio connection, but it does not itself provide the audio media stream.

WebRTC is commonly used for live audio communication between participants. The application may use Socket.IO to coordinate signaling and use WebRTC to transmit audio.

The design of proximity-based audio—such as deciding which nearby users can hear one another—requires additional application logic and should be coordinated with the backend and real-time developers.

8. Development and Security Considerations

Before integrating these technologies, the team should:

- Confirm the database schema, identifier types, and relationships.
- Decide how world membership and access permissions are validated.
- Define exact event payloads and error responses.
- Configure MongoDB connection strings and credentials securely using environment variables.
- Avoid exposing database credentials in source code or Git commits.
- Test database CRUD operations and Socket.IO connections.
- Handle disconnections, reconnections, and users leaving worlds.
- Consider indexes for frequently queried fields, such as world membership.
- Evaluate geospatial indexing if the application needs MongoDB to query stored geographic locations. The actual proximity and audio logic still needs to be designed.

9. Conclusion

MongoDB can provide persistent storage for ProxiSpeak's users, worlds, and membership information. Socket.IO can deliver real-time world events and avatar movement updates. WebRTC can support live audio communication.

Together, these technologies provide a foundation for the application's backend, but the final data structures, event payloads, security checks, and integration details must be agreed upon by the development team and verified through testing.

10. References

- MongoDB documentation: https://www.mongodb.com/docs/
- Socket.IO documentation: https://socket.io/docs/v4/
- WebRTC documentation: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API