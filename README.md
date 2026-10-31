# ProxiSpeak

**Geospatial Proximity Audio Ecosystem**

ProxiSpeak is a real-time virtual office platform where users can move their avatars around a shared virtual environment and communicate with other participants through proximity-based audio.

The project aims to make remote collaboration more interactive by combining real-time participant presence, avatar movement, and voice communication.

## Project Goals

- Real-time avatar movement.
- Shared virtual world for multiple participants.
- Distance-based voice communication.
- WebRTC-based audio communication.
- Real-time participant synchronization.
- User profile and availability management.
- Interactive virtual office experience.

## Key Features

### 1. Real-Time Participant Presence
Users can join the virtual office and view other connected participants. Participant information is synchronized through real-time communication.

### 2. Avatar Movement
Participants can move their avatars around the shared virtual environment. Movement updates are synchronized with other connected users.

### 3. Proximity-Based Audio
The platform supports voice communication using audio-related web technologies. Its goal is to make communication dependent on participants' proximity within the virtual environment.

### 4. User Profile Management
Users can customize their display name and avatar color.

### 5. Availability Status
Users can select their availability status:
- Available
- Away
- Busy
- Do Not Disturb

### 6. Backend Communication
The backend provides APIs and real-time Socket.IO communication to support participant synchronization and application functionality.

## Technology Stack

### Frontend
- React.js
- Vite
- JavaScript
- HTML5
- CSS3

### Backend
- Node.js
- Express.js
- Socket.IO

### Database
- MongoDB
- Mongoose

### Real-Time Audio
- WebRTC
- Web Audio API

### Development Tools
- Visual Studio Code
- Git
- GitHub
- npm

## Project Structure

```text
ProxiSpeak/
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── audioUtils.js
│   │   ├── presence.js
│   │   ├── profileUtils.js
│   │   └── useOfficeAudio.js
│   └── package.json
│
├── server/
│   ├── src/
│   └── package.json
│
└── README.md
```

## Installation and Setup

### Prerequisites
- Node.js
- npm
- MongoDB database access
- Git

### Step 1: Clone the Repository

```bash
git clone https://github.com/vaibhav-bajpai-18110/ProxiSpeak.git
cd ProxiSpeak
```

### Step 2: Install Backend Dependencies

```bash
cd server
npm install
```

Configure the required MongoDB connection and environment variables according to the server configuration.

### Step 3: Start Backend

```bash
npm start
```

### Step 4: Install Frontend Dependencies

Open a separate terminal:

```bash
cd client
npm install
```

### Step 5: Start Frontend

```bash
npm run dev
```

Open the local development URL provided by Vite.

## Testing and Validation

The project has undergone the following development checks:

- Frontend production build completed successfully.
- Automated test suite completed with 10 passing tests.
- ESLint reported zero errors and two warnings.
- Participant presence and movement manually tested.
- Audio functionality manually tested.
- Frontend and backend startup verified.

## Team Collaboration

ProxiSpeak is developed collaboratively using Git and GitHub.

The team follows a branch-based workflow to organize individual contributions, review changes, integrate features, and validate the application.

Changes are tracked through meaningful commits and pushed to the project repository.

## Future Improvements

- Further optimization of proximity-based audio.
- Improved user experience and interface.
- Better connection and error handling.
- Additional testing for multiple simultaneous participants.
- Performance and reliability improvements.

## Project Repository

GitHub: https://github.com/vaibhav-bajpai-18110/ProxiSpeak

---

**Project Name:** ProxiSpeak  
**Category:** Real-Time Virtual Collaboration Platform  
**Development Status:** Active Development
