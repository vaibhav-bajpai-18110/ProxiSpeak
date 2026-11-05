import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAudioStatusLabel,
  getMicrophoneErrorMessage,
} from "./audioUtils.js";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export function useOfficeAudio({ socket, started, isConnected, participants }) {
  const [microphoneStatus, setMicrophoneStatus] = useState("off");
  const [microphoneError, setMicrophoneError] = useState("");
  const [audioError, setAudioError] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const [peerStatuses, setPeerStatuses] = useState({});
  const [remoteStreams, setRemoteStreams] = useState({});
  const localStreamRef = useRef(null);
  const peersRef = useRef(new Map());
  const socketRef = useRef(socket);
  const startedRef = useRef(started);
  const connectedRef = useRef(isConnected);
  const mutedRef = useRef(isMuted);
  const participantsRef = useRef(participants);

  useEffect(() => {
    socketRef.current = socket;
    startedRef.current = started;
    connectedRef.current = isConnected;
    mutedRef.current = isMuted;
    participantsRef.current = participants;
  }, [socket, started, isConnected, isMuted, participants]);

  const updatePeerStatus = useCallback((peerId, status) => {
    setPeerStatuses((current) => ({ ...current, [peerId]: status }));
  }, []);

  const reportPlaybackError = useCallback(() => {
    setAudioError("Your browser blocked audio playback. Interact with the page, then retry audio.");
  }, []);

  const removePeer = useCallback((peerId) => {
    const entry = peersRef.current.get(peerId);
    if (entry) {
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.onnegotiationneeded = null;
      entry.pc.close();
      peersRef.current.delete(peerId);
    }
    setPeerStatuses((current) => {
      if (!(peerId in current)) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
    setRemoteStreams((current) => {
      if (!(peerId in current)) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  }, []);

  const closeAllPeers = useCallback(() => {
    if (peersRef.current.size === 0) return;
    for (const entry of peersRef.current.values()) {
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.onnegotiationneeded = null;
      entry.pc.close();
    }
    peersRef.current.clear();
    setPeerStatuses({});
    setRemoteStreams({});
  }, []);

  const ensurePeerConnection = useCallback((peerId) => {
    const activeSocket = socketRef.current;
    if (!activeSocket?.connected || !peerId || peerId === activeSocket.id || !window.RTCPeerConnection) return null;

    const existing = peersRef.current.get(peerId);
    if (existing) return existing;

    const pc = new window.RTCPeerConnection({ iceServers: ICE_SERVERS });
    const stream = localStreamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    }

    const entry = {
      pc,
      polite: String(activeSocket.id).localeCompare(String(peerId)) > 0,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
    };
    peersRef.current.set(peerId, entry);
    updatePeerStatus(peerId, "connecting");

    pc.onicecandidate = ({ candidate }) => {
      const currentSocket = socketRef.current;
      if (candidate && currentSocket?.connected) {
        currentSocket.emit("signal:ice-candidate", {
          targetId: peerId,
          candidate: candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event) => {
      const remoteStream = event.streams?.[0] || new window.MediaStream([event.track]);
      setRemoteStreams((current) => current[peerId] === remoteStream
        ? current
        : { ...current, [peerId]: remoteStream });
      updatePeerStatus(peerId, pc.connectionState === "connected" ? "connected" : "connecting");
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (["connecting", "connected", "disconnected", "failed"].includes(state)) {
        updatePeerStatus(peerId, state);
      }
      if (state === "connected") setAudioError("");
      if (state === "failed") setAudioError("Audio could not connect. Check your network, then retry audio.");
    };

    pc.onnegotiationneeded = async () => {
      const currentSocket = socketRef.current;
      if (!currentSocket?.connected || !connectedRef.current) return;
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription?.type === "offer" && currentSocket.connected) {
          currentSocket.emit("signal:offer", {
            targetId: peerId,
            offer: pc.localDescription,
          });
        }
      } catch {
        updatePeerStatus(peerId, "failed");
        setAudioError("Audio setup failed. Retry audio to try again.");
      } finally {
        entry.makingOffer = false;
      }
    };

    return entry;
  }, [updatePeerStatus]);

  const handleOffer = useCallback(async ({ senderId, offer } = {}) => {
    if (!senderId || !offer || !connectedRef.current) return;
    const entry = ensurePeerConnection(senderId);
    if (!entry) return;
    const { pc } = entry;
    const readyForOffer = !entry.makingOffer &&
      (pc.signalingState === "stable" || entry.isSettingRemoteAnswerPending);
    const offerCollision = !readyForOffer;
    entry.ignoreOffer = !entry.polite && offerCollision;
    if (entry.ignoreOffer) return;

    try {
      await pc.setRemoteDescription(offer);
      for (const candidate of entry.pendingCandidates.splice(0)) {
        await pc.addIceCandidate(candidate);
      }
      await pc.setLocalDescription();
      const activeSocket = socketRef.current;
      if (activeSocket?.connected) {
        activeSocket.emit("signal:answer", {
          targetId: senderId,
          answer: pc.localDescription,
        });
      }
    } catch {
      updatePeerStatus(senderId, "failed");
      setAudioError("Could not complete the audio handshake. Retry audio to try again.");
    }
  }, [ensurePeerConnection, updatePeerStatus]);

  const handleAnswer = useCallback(async ({ senderId, answer } = {}) => {
    if (!senderId || !answer) return;
    const entry = peersRef.current.get(senderId);
    if (!entry) return;
    try {
      entry.isSettingRemoteAnswerPending = true;
      await entry.pc.setRemoteDescription(answer);
      entry.isSettingRemoteAnswerPending = false;
      for (const candidate of entry.pendingCandidates.splice(0)) {
        await entry.pc.addIceCandidate(candidate);
      }
    } catch {
      entry.isSettingRemoteAnswerPending = false;
      updatePeerStatus(senderId, "failed");
      setAudioError("Could not complete the audio handshake. Retry audio to try again.");
    }
  }, [updatePeerStatus]);

  const handleIceCandidate = useCallback(async ({ senderId, candidate } = {}) => {
    if (!senderId || !candidate || !connectedRef.current) return;
    const entry = ensurePeerConnection(senderId);
    if (!entry || entry.ignoreOffer) return;
    if (!entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      if (!entry.ignoreOffer) {
        updatePeerStatus(senderId, "failed");
        setAudioError("A network candidate could not be added to the audio connection.");
      }
    }
  }, [ensurePeerConnection, updatePeerStatus]);

  useEffect(() => {
    if (!socket) return undefined;
    socket.on("signal:offer", handleOffer);
    socket.on("signal:answer", handleAnswer);
    socket.on("signal:ice-candidate", handleIceCandidate);
    return () => {
      socket.off("signal:offer", handleOffer);
      socket.off("signal:answer", handleAnswer);
      socket.off("signal:ice-candidate", handleIceCandidate);
    };
  }, [socket, handleOffer, handleAnswer, handleIceCandidate]);

  useEffect(() => {
    if (!started || !isConnected || !socket?.connected) {
      localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
      closeAllPeers();
      return;
    }

    const stream = localStreamRef.current;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) track.enabled = !mutedRef.current;
    for (const participant of participants) {
      if (participant.id !== socket.id && participant.status === "online") {
        ensurePeerConnection(participant.id);
      }
    }
  }, [started, isConnected, socket, participants, closeAllPeers, ensurePeerConnection]);

  const requestMicrophone = useCallback(async () => {
    if (microphoneStatus === "requesting") return;
    setMicrophoneError("");
    setAudioError("");

    if (!socketRef.current?.connected || !connectedRef.current) {
      setMicrophoneError("Connect to the office before joining audio.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      setMicrophoneStatus("unavailable");
      setMicrophoneError("Microphone audio requires a supported browser and a secure connection (HTTPS or localhost).");
      return;
    }

    setMicrophoneStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (!startedRef.current || !connectedRef.current || !socketRef.current?.connected) {
        stream.getTracks().forEach((track) => track.stop());
        setMicrophoneStatus("off");
        return;
      }

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        setMicrophoneStatus("unavailable");
        setMicrophoneError("No audio track was provided by the selected microphone.");
        return;
      }

      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = stream;
      mutedRef.current = false;
      setIsMuted(false);
      setMicrophoneStatus("ready");
      for (const participant of participantsRef.current) {
        if (participant.id !== socketRef.current.id && participant.status === "online") {
          ensurePeerConnection(participant.id);
        }
      }
      for (const track of audioTracks) {
        track.addEventListener("ended", () => {
          setMicrophoneStatus("unavailable");
          setMicrophoneError("Your microphone disconnected. Rejoin audio to continue.");
        }, { once: true });
      }
    } catch (error) {
      const denied = ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error?.name);
      setMicrophoneStatus(denied ? "denied" : "unavailable");
      setMicrophoneError(getMicrophoneErrorMessage(error));
    }
  }, [ensurePeerConnection, microphoneStatus]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !mutedRef.current;
    for (const track of localStreamRef.current.getAudioTracks()) track.enabled = !nextMuted;
    mutedRef.current = nextMuted;
    setIsMuted(nextMuted);
  }, []);

  const retryAudio = useCallback(() => {
    setAudioError("");
    closeAllPeers();
    if (!localStreamRef.current) {
      void requestMicrophone();
      return;
    }
    for (const participant of participantsRef.current) {
      if (participant.id !== socketRef.current?.id && participant.status === "online") {
        ensurePeerConnection(participant.id);
      }
    }
  }, [closeAllPeers, ensurePeerConnection, requestMicrophone]);

  const leaveAudio = useCallback(() => {
    closeAllPeers();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    mutedRef.current = false;
    setMicrophoneStatus("off");
    setMicrophoneError("");
    setAudioError("");
    setIsMuted(false);
  }, [closeAllPeers]);

  const onlinePeerCount = participants.filter((participant) => !participant.isYou && participant.status === "online").length;
  const connectedPeerCount = Object.values(peerStatuses).filter((status) => status === "connected").length;
  const hasFailedPeer = Object.values(peerStatuses).some((status) => status === "failed");
  const statusLabel = getAudioStatusLabel({
    microphoneStatus,
    isMuted,
    peerStatuses,
    onlinePeerCount,
    isConnected: started && isConnected,
  });

  useEffect(() => () => {
    for (const entry of peersRef.current.values()) entry.pc.close();
    peersRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
  }, []);

  return {
    microphoneStatus,
    microphoneError,
    audioError,
    isMuted,
    peerStatuses,
    remoteStreams,
    onlinePeerCount,
    connectedPeerCount,
    hasFailedPeer,
    statusLabel,
    requestMicrophone,
    toggleMute,
    retryAudio,
    leaveAudio,
    reportPlaybackError,
    removeParticipant: removePeer,
  };
}
