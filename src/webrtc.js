export const iceServers = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
};

export function createPeerConnection({ peerId, localStream, onTrack, onIceCandidate }) {
  const pc = new RTCPeerConnection(iceServers);

  // Send our tracks
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.ontrack = (event) => {
    onTrack(peerId, event.streams[0]);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) onIceCandidate(peerId, event.candidate);
  };

  return pc;
}
