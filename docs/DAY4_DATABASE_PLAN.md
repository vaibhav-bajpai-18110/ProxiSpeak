ProxiSpeak — Day 4 Database Design Plan

1. Introduction

ProxiSpeak is an application where users can communicate in real time. This document proposes how MongoDB will store user and conversation information, and how Socket.IO will support live communication between users.

This is a design plan only. It does not create a database connection or contain credentials.

2. User Collection

The "users" collection will store information about each registered user.

Example document

{
  "_id": "user_101",
  "name": "Manya",
  "email": "manya@example.com",
  "createdAt": "2026-10-18T10:00:00Z"
}

Field explanation

- "_id": A unique identifier for the user. MongoDB can generate an ObjectId; the example uses a readable placeholder.
- "name": The user's display name.
- "email": The user's email address. It should be unique so one email cannot create multiple accounts.
- "createdAt": The date and time when the account was created.

In a real application, authentication information must be handled securely. Passwords should never be stored as plain text. This plan does not define or configure authentication.

3. Conversation Collection

The "conversations" collection will store information about each conversation, such as who is participating and whether it is active or closed.

Example document

{
  "_id": "conversation_501",
  "participants": ["user_101", "user_202"],
  "createdAt": "2026-10-18T10:15:00Z",
  "status": "active"
}

Field explanation

- "_id": A unique identifier for the conversation.
- "participants": The IDs of the users in the conversation.
- "createdAt": When the conversation was created.
- "status": The conversation's current state, for example "active" or "closed".

The participant IDs refer to documents in the "users" collection. This helps the backend identify which users belong to a conversation.

Possible future message storage

If ProxiSpeak needs to save message history, a separate "messages" collection could store each message with its conversation ID, sender ID, text, and timestamp. Keeping messages separate can make it easier to retrieve conversation history without making the conversation document too large. This is a future design option, not part of the current required schema.

4. MongoDB's Role

MongoDB will store persistent application data—information that should remain available after a user disconnects or the server restarts.

For example:

- The "users" collection stores registered user profiles.
- The "conversations" collection stores conversation participants, creation time, and status.
- In a future implementation, a "messages" collection could store message history.

The backend will read and write this information to MongoDB. The frontend should not connect directly to the database; it should send requests to the backend.

5. Socket.IO's Role

Socket.IO enables real-time communication between the frontend and backend. It allows the server to send events to connected clients without requiring the frontend to repeatedly ask for updates.

Possible events include:

Event| Purpose
"connect"| Indicates that the client has connected to the Socket.IO server.
"disconnect"| Indicates that the client has disconnected.
"join-conversation"| Requests to join a conversation's real-time room.
"conversation-joined"| Confirms that the server has joined the client to the conversation room.
"send-message"| Sends a message event to the backend.
"new-message"| Notifies conversation participants about a new message.

The backend should verify that a user is allowed to join a conversation before placing their socket in its room. It should also validate incoming message data.

Socket.IO events provide live delivery; they do not automatically make data permanent. If message history is required, the backend must save messages to MongoDB.

6. Proposed Data Flow

1. The user interacts with the ProxiSpeak frontend.
2. The frontend sends a request or Socket.IO event to the backend.
3. The backend validates the request and checks the user's access to the conversation.
4. When persistent information is needed, the backend reads from or writes to MongoDB.
5. For real-time updates, the backend emits Socket.IO events to the relevant conversation room.
6. Connected participants receive the event and update their interface.

Example: Sending a message

- A participant sends a "send-message" event.
- The backend checks the sender and conversation.
- If message history is being implemented, the backend saves the message in MongoDB.
- The backend emits a "new-message" event to the conversation room.
- Other connected participants receive the message and display it.

7. Design and Security Considerations

- Use unique IDs to identify users and conversations.
- Validate data on the backend before saving it.
- Check conversation membership before allowing a user to join its Socket.IO room or send messages.
- Do not expose database credentials, passwords, or API keys in frontend code or this document.
- Store only the personal information the application needs.
- Decide the final schema with the team before implementing it.

8. Conclusion

MongoDB is proposed for storing ProxiSpeak's persistent user and conversation data. Socket.IO is proposed for live connection and event delivery. The backend coordinates both: it validates requests, accesses the database when needed, and sends real-time events to authorized participants.

This document describes a proposed design. The schema and event names may be adjusted after team review.

References

- MongoDB documentation: https://www.mongodb.com/docs/manual/
- MongoDB documents: https://www.mongodb.com/docs/manual/core/document/
- MongoDB CRUD operations: https://www.mongodb.com/docs/manual/crud/
- Socket.IO documentation: https://socket.io/docs/v4/
- Socket.IO rooms: https://socket.io/docs/v4/rooms/