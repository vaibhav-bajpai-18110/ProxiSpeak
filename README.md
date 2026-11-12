# ProxiSpeak – Geospatial Proximity Audio Ecosystem

![Project](https://img.shields.io/badge/Project-ProxiSpeak-blue)
![Status](https://img.shields.io/badge/Development-Completed-green)
![Domain](https://img.shields.io/badge/Domain-Virtual%20Collaboration-purple)

## Overview

ProxiSpeak is a virtual office collaboration platform designed to make remote communication more natural and interactive.

It provides a shared virtual workspace where users are represented by avatars and can interact with nearby participants through real-time communication.

The project explores proximity-based audio interaction using modern web technologies such as WebRTC, Socket.IO, React, Node.js, and MongoDB.

## Problem Statement

Traditional video conferencing applications mainly depend on fixed meeting rooms and scheduled communication.

They do not fully recreate spontaneous conversations that naturally happen in physical offices.

ProxiSpeak aims to address this limitation by introducing a virtual office where users can move around and interact with nearby participants.

## Key Features

- Interactive virtual office environment.
- Avatar-based participant representation.
- Real-time participant movement.
- Real-time communication using Socket.IO.
- WebRTC-based peer-to-peer audio communication.
- Proximity-oriented audio interaction.
- User profile management.
- Audio controls.
- Workspace and room management.
- Database-backed application information.

*Features should reflect the functionality available in the final submitted version.*

## Technology Stack

| Category | Technology |
|---|---|
| Frontend | React.js, JavaScript |
| Styling | HTML5, CSS3 |
| Backend | Node.js, Express.js |
| Real-time Communication | Socket.IO |
| Audio Communication | WebRTC |
| Audio Processing | Web Audio API |
| Database | MongoDB |
| Version Control | Git and GitHub |

## System Architecture

The application follows a client-server architecture.

1. The React frontend displays the virtual office.
2. The backend handles requests and application logic.
3. Socket.IO manages real-time signaling events.
4. WebRTC supports peer-to-peer audio communication.
5. MongoDB stores persistent application information.

## Project Structure

```text
ProxiSpeak/
│
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   └── useOfficeAudio.js
│   ├── public/
│   └── package.json
│
├── server/
│   ├── models/
│   ├── routes/
│   ├── services/
│   └── package.json
│
├── README.md
└── .gitignore
```

*Update this tree according to the actual repository folders and files.*

## Installation and Setup

### Prerequisites

- Node.js
- npm
- MongoDB connection
- Git
- VS Code

### Step 1: Clone the Repository

```bash
git clone https://github.com/vaibhav-bajpai-18110/ProxiSpeak.git
```

### Step 2: Navigate to the Project

```bash
cd ProxiSpeak
```

### Step 3: Install Frontend Dependencies

```bash
cd client
npm install
```

### Step 4: Configure Environment Variables

Create the required `.env` file using the variable names expected by the application.

Example:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
```

Do not commit passwords, database credentials, or private API keys.

### Step 5: Start the Frontend

```bash
npm run dev
```

### Step 6: Start the Backend

Open another terminal and navigate to the server directory.

```bash
cd server
npm install
npm start
```

Use the actual start scripts defined in the respective package.json files. If the backend uses a different development command, use that command instead.

## Application Workflow

1. User opens the ProxiSpeak application.
2. User accesses the virtual workspace.
3. The application displays the available participants.
4. Users interact with the virtual office through their avatars.
5. Real-time events are exchanged through the server.
6. WebRTC establishes audio connections where supported.
7. Proximity-oriented logic manages the communication experience.

## Team Members

| Name | Responsibility |
|---|---|
| Vaibhav Bajpai | Team Leader and Integration |
| Harshavardhan | Frontend Development |
| Rakesh | Backend Development |
| Manya | Database and Testing |

## Testing

Testing activities include:

- Frontend interface testing.
- Backend API testing.
- Socket.IO communication testing.
- Database connectivity and persistence testing.
- WebRTC connection testing.
- Audio functionality testing.
- Integration testing.

## Future Improvements

- Advanced 3D spatial audio.
- Better support for concurrent participants.
- More virtual office layouts.
- Enhanced avatar customization.
- Improved performance and scalability.
- Mobile-friendly interface.

## Project Information

**Project Name:** ProxiSpeak

**Project Category:** Virtual Collaboration and Real-Time Communication

**Organization:** Infotact Solutions

**Project Leader:** Vaibhav Bajpai

## Acknowledgement

Developed as an internship project with the objective of exploring modern web development, real-time communication, and virtual collaboration technologies.

---

**Made by Team ProxiSpeak**