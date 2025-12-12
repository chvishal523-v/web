import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { createPeerConnection } from "./webrtc";

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "http://localhost:4000";

export default function App() {
  const socket = useMemo(() => io(SIGNALING_URL, { transports: ["websocket"] }), []);
  const [mode, setMode] = useState(null); // null | "host" | "join"
  const [roomId, setRoomId] = useState("");
  const [password, setPassword] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [error, setError] = useState("");

  const localVideoRef = useRef(null);
  const [remoteStreams, setRemoteStreams] = useState({}); // peerId -> MediaStream
  const pcsRef = useRef({}); // peerId -> RTCPeerConnection
  const localStreamRef = useRef(null);

  async function initLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    return stream;
  }

  function cleanupPeer(peerId) {
    const pc = pcsRef.current[peerId];
    if (pc) pc.close();
    delete pcsRef.current[peerId];
    setRemoteStreams((prev) => {
      const copy = { ...prev };
      delete copy[peerId];
      return copy;
    });
  }

  function setRemote(peerId, stream) {
    setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
  }

  async function makeOffer(toPeerId) {
    const localStream = await initLocalMedia();
    const pc = createPeerConnection({
      peerId: toPeerId,
      localStream,
      onTrack: setRemote,
      onIceCandidate: (peerId, candidate) => {
        socket.emit("webrtc-ice", { to: peerId, from: socket.id, candidate });
      }
    });
    pcsRef.current[toPeerId] = pc;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit("webrtc-offer", { to: toPeerId, from: socket.id, sdp: offer });
  }

  async function handleOffer(from, sdp) {
    const localStream = await initLocalMedia();
    const pc = createPeerConnection({
      peerId: from,
      localStream,
      onTrack: setRemote,
      onIceCandidate: (peerId, candidate) => {
        socket.emit("webrtc-ice", { to: peerId, from: socket.id, candidate });
      }
    });
    pcsRef.current[from] = pc;

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("webrtc-answer", { to: from, from: socket.id, sdp: answer });
  }

  async function handleAnswer(from, sdp) {
    const pc = pcsRef.current[from];
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async function handleIce(from, candidate) {
    const pc = pcsRef.current[from];
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      // ignore if failed due to timing
    }
  }

  useEffect(() => {
    socket.on("peer-joined", async ({ peerId }) => {
      // Existing users create an offer to the new peer
      await makeOffer(peerId);
    });

    socket.on("peer-left", ({ peerId }) => cleanupPeer(peerId));

    socket.on("webrtc-offer", ({ from, sdp }) => handleOffer(from, sdp));
    socket.on("webrtc-answer", ({ from, sdp }) => handleAnswer(from, sdp));
    socket.on("webrtc-ice", ({ from, candidate }) => handleIce(from, candidate));

    return () => {
      socket.off("peer-joined");
      socket.off("peer-left");
      socket.off("webrtc-offer");
      socket.off("webrtc-answer");
      socket.off("webrtc-ice");
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function hostRoom() {
    setError("");
    socket.emit("host-room", { roomId, password }, async (res) => {
      if (!res?.ok) return setError(res?.error || "Host failed");
      await initLocalMedia();
      setInRoom(true);
    });
  }

  async function joinRoom() {
    setError("");
    socket.emit("join-room", { roomId, password }, async (res) => {
      if (!res?.ok) return setError(res?.error || "Join failed");
      await initLocalMedia();
      setInRoom(true);

      // New user offers to existing peers (fast connect)
      for (const peerId of res.peers || []) {
        await makeOffer(peerId);
      }
    });
  }

  if (!inRoom) {
    return (
      <div style={{ padding: 16, maxWidth: 520, fontFamily: "system-ui, sans-serif" }}>
        <h2>WebRTC Room (Max 4)</h2>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={() => setMode("host")}>Host</button>
          <button onClick={() => setMode("join")}>Join</button>
        </div>

        <input
          placeholder="Room ID"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 8 }}
        />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 8 }}
        />

        {mode === "host" && <button onClick={hostRoom}>Create Room</button>}
        {mode === "join" && <button onClick={joinRoom}>Join Room</button>}

        <p style={{ marginTop: 10, opacity: 0.8 }}>
          Signaling URL: <code>{SIGNALING_URL}</code>
        </p>

        {error && <p style={{ color: "red" }}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h3>Room: {roomId} (Max 4)</h3>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        <VideoTile title="You" videoRef={localVideoRef} muted />

        {Object.entries(remoteStreams).map(([peerId, stream]) => (
          <RemoteVideoTile key={peerId} peerId={peerId} stream={stream} />
        ))}
      </div>
    </div>
  );
}

function VideoTile({ title, videoRef, muted }) {
  return (
    <div style={{ border: "1px solid #ddd", padding: 8, borderRadius: 8 }}>
      <div style={{ fontSize: 12, marginBottom: 6 }}>{title}</div>
      <video ref={videoRef} autoPlay playsInline muted={muted} style={{ width: "100%" }} />
    </div>
  );
}

function RemoteVideoTile({ peerId, stream }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div style={{ border: "1px solid #ddd", padding: 8, borderRadius: 8 }}>
      <div style={{ fontSize: 12, marginBottom: 6 }}>Peer: {peerId.slice(0, 6)}...</div>
      <video ref={ref} autoPlay playsInline style={{ width: "100%" }} />
    </div>
  );
}
