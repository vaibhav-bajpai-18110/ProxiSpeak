# Day 9 — Socket.IO Communication Session Verification
## Integration test
`day9-integration-check.js`
## Verified locally
- Two Socket.IO clients connected.
- Starting a communication session returned a session ID.
- The other participant received the session-start notification.
- Ending the session returned an ended status and notified the other participant.
- Starting a session with oneself was rejected.
- Ending a nonexistent session was rejected.
- Disconnecting a participant ended the active session, notified the remaining participant, and persisted `status: ended` and `endedAt` in MongoDB.
## Test result
The integration script reported `DAY 9 SOCKET INTEGRATION: PASS`.
## Scope and remaining checks
This report records the integration behaviors tested; it does not certify completion against the original Day 9 assignment rubric, which has not been provided.
The test does not separately verify the MongoDB record after a normal session end.
