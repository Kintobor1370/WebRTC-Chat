import './style.css';

import firebase from 'firebase/app';
import 'firebase/firestore';
import config from './firebaseConfig.json' with { type: 'json' }

// Import firebase configuration parameters
const firebaseConfig = {
  apiKey: config.apiKey,
  authDomain: config.authDomain,
  projectId: config.projectId,
  storageBucket: config.storageBucket,
  messagingSenderId: config.messagingSenderId,
  appId: config.appId
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const firestore = firebase.firestore();

const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

// Global State
const pc = new RTCPeerConnection(servers);
const pcSend = new RTCPeerConnection(servers);
const pcReceive = new RTCPeerConnection(servers);
let localStream = null;
let remoteStream = null;


// HTML elements
const camButton = document.getElementById('camButton');
const micButton = document.getElementById('micButton');
const shrButton = document.getElementById('shrButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput');
const joinButton = document.getElementById('joinButton');
const remoteVideo = document.getElementById('remoteVideo');
const endButton = document.getElementById('endButton');

// Button text elements
const enMsg = "Enable ";
const disMsg = "Disable ";
const camMsg = "Camera";
const micMsg = "Microphone";
const shrMsg = "Screen Sharing";

let enableCam = false;
let enableMic = false;
let enableShr = false;

// Initial setup
const noiseCancelConfig = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true
};
remoteStream = new MediaStream();
updateButtons();

// 1. Camera button press
camButton.onclick = async () => {
  // Change camera connectivity
  localStream = 
    !enableCam || enableMic ? 
      await navigator.mediaDevices.getUserMedia({ 
        video: !enableCam,
        audio: enableMic ? noiseCancelConfig : false
      }) :
      new MediaStream();

  // Confirm camera connectivity
  enableCam = !enableCam;
  enableShr = false;
  console.log("Camera: ", enableCam ? "ON" : "OFF");
  
  updateStreams();
  updateButtons();
};

// 2. Microphone button press
micButton.onclick = async () => {
  // Change microphone connectivity
  localStream = 
    enableCam || !enableMic ? 
      await navigator.mediaDevices.getUserMedia({ 
        video: enableCam,
        audio: !enableMic ? noiseCancelConfig : false
      }) :
      new MediaStream();
  
  // Confirm microphone connectivity
  enableMic = !enableMic;
  enableShr = false;
  console.log("Microphone: ", enableMic ? "ON" : "OFF");
  
  updateStreams();
  updateButtons();
};

// 3. Screen sharing button press
shrButton.onclick = async () => {
  // Change screen sharing
  localStream = 
    !enableShr ?
      await navigator.mediaDevices.getDisplayMedia({ 
        video: true,
        audio: true
      }) :
      new MediaStream();

  // Confirm screen sharing
  enableShr = !enableShr;
  enableCam = false;
  enableMic = false;
  console.log("Screen sharing: ", enableShr ? "ON" : "OFF");

  updateStreams();
  updateButtons();
};

// 4. Create an offer
callButton.onclick = async () => {
  // Reference Firestore collections for signaling
  const callDoc = firestore.collection('calls').doc();
  const offerCandidates = callDoc.collection('offerCandidates');
  const answerCandidates = callDoc.collection('answerCandidates');

  // Display call ID
  document.getElementById('idDisplay').innerHTML = 'Your call ID: ' + callDoc.id;

  // Get candidates for caller, save to db
  pc.onicecandidate = (event) => {
    event.candidate && offerCandidates.add(event.candidate.toJSON());
  };

  // Create offer
  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  const offer = {
    sdp: offerDescription.sdp,
    type: offerDescription.type,
  };

  await callDoc.set({ offer });

  // Listen for remote answer
  callDoc.onSnapshot((snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

  // When answered, add candidate to peer connection
  answerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });

  document.getElementById('callButton').innerHTML = 'Created!';
  callButton.disabled = true;
  endButton.disabled = false;
};

// 5. Join the call with the unique ID
joinButton.onclick = async () => {
  const callId = callInput.value;
  const callDoc = firestore.collection('calls').doc(callId);
  const answerCandidates = callDoc.collection('answerCandidates');
  const offerCandidates = callDoc.collection('offerCandidates');

  const snapshotAnswer = await answerCandidates.get();
  const snapshotOffer = await offerCandidates.get();
  console.log(snapshotAnswer.size, snapshotOffer.size);
  if (snapshotAnswer.size === 0 && snapshotOffer.size === 0) {
    document.getElementById('answerStatus').innerHTML = 'Sorry, this call does not exist. Please try a different ID.';
  }
  else {
    document.getElementById('answerStatus').innerHTML = 'Call found!';
    pc.onicecandidate = (event) => {
      event.candidate && answerCandidates.add(event.candidate.toJSON());
    };

    const callData = (await callDoc.get()).data();

    const offerDescription = callData.offer;
    await pc.setRemoteDescription(new RTCSessionDescription(offerDescription));

    const answerDescription = await pc.createAnswer();
    await pc.setLocalDescription(answerDescription);

    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };

    await callDoc.update({ answer });

    offerCandidates.onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        console.log('Change: ', change);
        if (change.type === 'added') {
          let data = change.doc.data();
          pc.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
  }
};

async function updateStreams() {
  // If camera, microphone, and screen sharing are disabled
  if (!enableCam && !enableMic && !enableShr) {
    // Stop the current tracks for the local stream
    localStream.getTracks().forEach((track) => track.stop());
    console.log('Tracks stopped!');
  }

  // Push tracks from local stream to peer connection
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // Pull tracks from peer connection (remote stream), add to video stream
  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
  };

  // Update the frontend components
  webcamVideo.srcObject = localStream;
  remoteVideo.srcObject = remoteStream;
}

async function updateButtons() {
  document.getElementById('camButton').innerHTML = enableCam ? disMsg + camMsg : enMsg + camMsg;
  document.getElementById('micButton').innerHTML = enableMic ? disMsg + micMsg : enMsg + micMsg;
  document.getElementById('shrButton').innerHTML = enableShr ? disMsg + shrMsg : enMsg + shrMsg;
  callButton.disabled = !enableCam && !enableMic && !enableShr;
  joinButton.disabled = !enableCam && !enableMic && !enableShr;
}
