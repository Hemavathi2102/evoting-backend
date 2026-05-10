const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const QRCode = require("qrcode");
const http = require("http");
const { Server } = require("socket.io");
const os = require("os");
const nodemailer = require("nodemailer");
require("dotenv").config();
const PORT = process.env.PORT || 5000;


const app = express();
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://evoting-frontend.onrender.com"
  ],
  methods: ["GET", "POST", "PUT"],
  credentials: true
}));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("E-Voting Backend Running Successfully 🚀");
});

// ✅ Create HTTP server
const server = http.createServer(app);


// ✅ Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://evoting-frontend.onrender.com"],
    methods: ["GET", "POST", "PUT"]
  }
});

io.on("connection", (socket) => {
  console.log("🟢 New client connected:", socket.id);

  socket.on("joinRoom", (voterId) => {
    const cleanId = voterId.trim();
    socket.join(cleanId);
    console.log("✅ Joined Room:", cleanId);
  });

  // 📊 Admin dashboard connection
  socket.on("adminJoin", async () => {
    console.log("📊 Admin joined dashboard");

    const results = await Vote.aggregate([
      { $match: { voted: true } },
      { $group: { _id: "$party", count: { $sum: 1 } } }
    ]);

    socket.emit("voteUpdate", results);
  });  

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected:", socket.id);
  });
});

app.get("/check-server", (req, res) => {
  res.send("THIS IS THE CORRECT BACKEND");
});

// ✅ Connect MongoDB
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("DB Connected"))
.catch(err => console.log(err));

// ✅ Vote Schema
const voteSchema = new mongoose.Schema({
  voterId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  registerNumber: { type: String, required: true, unique: true },
  aadhaar: { type: String, required: true, unique: true },

  otp: { type: String, default: null },

  verifiedPhone: { type: Boolean, default: false },
  verified: { type: Boolean, default: false },
  voted: { type: Boolean, default: false },

  party: { type: String }
});

const Vote = mongoose.model("Vote", voteSchema);

// ✅ EMAIL SETUP
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

let electionEnded = false; 


app.post("/register", async (req, res) => {
  console.log("REGISTER HIT");

  try {
    const { name, phone, email, registerNumber, voterId, aadhaar } = req.body || {};

    if (!req.body) {
      return res.status(400).json({ message: "Body not received" });
    }

    if (!name || !phone || !email || !registerNumber || !voterId || !aadhaar) {
      return res.status(400).json({ message: "All fields required" });
    }

    let errors = [];

    const phoneExists = await Vote.findOne({ phone });
    if (phoneExists) errors.push("Phone number already exists");

    const registerExists = await Vote.findOne({ registerNumber });
    if (registerExists) errors.push("Register number already exists");

    const voterExists = await Vote.findOne({ voterId });
    if (voterExists) errors.push("Voter ID already exists");

    const aadhaarExists = await Vote.findOne({ aadhaar });
    if (aadhaarExists) errors.push("Aadhaar already exists");

    if (errors.length > 0) {
      return res.status(400).json({
        message: errors.join(", ")
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const voter = new Vote({
      name,
      phone,
      email,
      registerNumber,
      voterId,
      aadhaar,
      otp,
      verifiedPhone: true,
      verified: false,
      voted: false
    });

    await voter.save();

    // ✅ EMAIL inside try block
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "OTP",
        text: `OTP: ${otp}`
      });
    } catch (err) {
      console.log("Mail failed:", err.message);
    }

    return res.json({ message: "Registration successful" });

  } catch (err) {
    console.error("REGISTER ERROR:", err);

    if (err.code === 11000) {
      return res.status(400).json({
        message: "Duplicate entry detected"
      });
    }

    return res.status(500).json({
      message: err.message
    });
  }
});

// ✅ Get Voter Details
app.get("/voter/:id", async (req, res) => {
  try {
    const voter = await Vote.findOne(
  { voterId: req.params.id },
  "-password"
);
    if (!voter) {
      return res.status(404).json({ message: "Voter not found" });
    }

    res.json(voter);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Check if voter is verified (for Poll page)
app.get("/check-verified/:id", async (req, res) => {
  try {
    const voter = await Vote.findOne({ voterId: req.params.id });
    if (!voter) {
      return res.status(404).json({ verified: false });
    }
    res.json({ verified: voter.verified });
  } catch (err) {
    res.status(500).json({ verified: false });
  }
});

// ✅ Confirm from Mobile (Verification Only)
app.put("/confirm/:id", async (req, res) => {
  try {
     const voterId = req.params.id.trim();
     const voter = await Vote.findOne({ voterId });

     if (!voter)
     return res.status(404).json({ message: "Voter not found" });

    io.to(voterId).emit("mobileStartedVerification");  

    if (voter.voted)
      return res.status(400).json({ message: "Already voted" });

    if (voter.verified)
      return res.status(400).json({ message: "Already verified" });

    if (!voter.verifiedPhone) 
      return res.status(400).json({ message: "Phone not verified" });
    

    voter.verified = true;
    await voter.save();

    io.to(voterId).emit("sessionVerified", voterId);
    console.log("🔥 Emitting sessionVerified to room:", voterId);
    console.log("Rooms:", io.sockets.adapter.rooms);

    res.json({ message: "Verification successful" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();

  for (let name of Object.keys(interfaces)) {
    for (let iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }

  return "localhost";
}


// ✅ Register Vote + Generate QR (PREVENT DUPLICATE)
app.post("/vote", async (req, res) => {
  try {
    const { voterId, password } = req.body;

    if (!voterId || !password) {
      return res.status(400).json({ message: "Voter ID and OTP required" });
    }

    // 🔍 1. Find voter
    const voter = await Vote.findOne({ voterId });

    if (!voter) {
      return res.status(404).json({ message: "Voter not registered" });
    }

    // 🔐 2. OTP CHECK
    if (voter.otp !== password) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // 🚫 3. ALREADY VOTED CHECK (THIS IS THE KEY)
    if (voter.voted) {
      return res.status(400).json({
        message: "You have already voted. Voting again is not allowed."
      });
    }
   
    voter.verified = false;
    await voter.save();

    const LOCAL_IP = getLocalIP();
    const qrData = `https://evoting-backend-62hq.onrender.com/mobile/${voter.voterId}`;
    const qrImage = await QRCode.toDataURL(qrData);

    const safeVote = voter.toObject(); 

    res.json({
      message: "QR generated successfully",
      vote: safeVote,
      qrCode: qrImage,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get("/mobile/:id", async (req, res) => {
  try {
    const voterId = req.params.id.trim();
    const voter = await Vote.findOne({ voterId });

    if (!voter) {
      return res.send("<h2>Voter Not Found ❌</h2>");
    }

    if (voter.voted) {
      return res.send(`
        <h2 style="color:red;text-align:center;margin-top:100px;">
          You have already voted ❌
        </h2>
      `);
    }
    res.setHeader("Cache-Control", "no-store"); // Prevent caching

res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Secure Voter Verification</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background: linear-gradient(135deg, #0f2027, #203a43, #2c5364);
      font-family: Arial, sans-serif;
      color: white;
    }

    .card {
      background: rgba(0,0,0,0.6);
      padding: 40px;
      border-radius: 15px;
      text-align: center;
      box-shadow: 0 0 25px rgba(0,255,255,0.3);
      width: 90%;
      max-width: 400px;
    }

    h1 {
      font-size: 26px;
      margin-bottom: 20px;
      color: #00ffff;
    }

    .details {
      font-size: 20px;
      margin: 15px 0;
    }

    .question {
      margin-top: 25px;
      font-size: 18px;
      font-weight: bold;
    }

    .btn {
      padding: 15px 30px;
      font-size: 18px;
      border: none;
      border-radius: 8px;
      margin: 15px 10px;
      cursor: pointer;
      transition: 0.3s;
    }

    .yes {
      background: #00c853;
      color: white;
    }

    .yes:hover {
      background: #00e676;
      transform: scale(1.05);
    }

    .no {
      background: #d50000;
      color: white;
    }

    .no:hover {
      background: #ff1744;
      transform: scale(1.05);
    }
  </style>
</head>

<body>

<div class="card">
  <h1>🗳 Secure Voter Verification</h1>

  <div class="details">
    <p><strong>Name:</strong> ${voter.name}</p>
    <p><strong>Voter ID:</strong> ${voter.voterId}</p>
  </div>

  <div class="question">
    Are you the above voter?
  </div>

  <button class="btn yes" onclick="confirmVote()">YES</button>
  <button class="btn no" onclick="cancelVote()">NO</button>
</div>

<script>
  const voterId = "${voter.voterId}"; // inject server-side variable safely

  function confirmVote() {
    fetch("https://evoting-backend-62hq.onrender.com/confirm/" + voterId, {
      method: "PUT"
    })
    .then(res => res.json())
    .then(data => {
      document.body.innerHTML = 
        "<h1 style='color:#00ff99;text-align:center;margin-top:100px;'>✔ Verification Successful</h1>";
    })
    .catch(err => {
      alert("Error verifying");
    });
  }

  function cancelVote() {
    document.body.innerHTML = 
      "<h1 style='color:#ff4444;text-align:center;'>✖ Verification Cancelled</h1>";
  }
</script>

</body>
</html>
`);

  } catch (error) {
    console.error(error);
    res.send("<h2>Server Error</h2>");
  }
});


app.post("/final-vote", async (req, res) => {
  try {

    if (electionEnded) {
      return res.status(400).json({
        message: "Election has ended. Voting is closed."
      });
    }

    const { voterId, password, party } = req.body;

    console.log("FINAL VOTE BODY:", req.body);

    const voter = await Vote.findOne({ voterId: voterId.trim() });

    if (!voter) {
      return res.status(404).json({ message: "Voter not found" });
    }

    if (!voter.verified) {
      return res.status(400).json({ message: "Mobile not verified" });
    }

    if (voter.voted) {
      return res.status(400).json({ message: "You already voted" });
    }

    if (voter.otp !== password) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    voter.voted = true;
    voter.party = party;
    await voter.save();

        // 📊 Calculate vote counts
    const results = await Vote.aggregate([
      { $match: { voted: true } },
      { $group: { _id: "$party", count: { $sum: 1 } } }
    ]);

    // 🔴 Emit to admin dashboard
    io.emit("voteUpdate", results);

    res.json({ message: "Vote cast successfully" });

  } catch (err) {
    console.log("FINAL VOTE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ Get all votes
app.get("/votes", async (req, res) => {
  try {
    const votes = await Vote.find({}, "-password");
    res.json(votes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/end-election", async (req, res) => {
  try {

    electionEnded = true;

    const results = await Vote.aggregate([
      { $match: { voted: true } },
      { $group: { _id: "$party", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const winner = results[0];

    res.json({
      message: "Election ended",
      winner: winner ? winner._id : "No votes",
      votes: winner ? winner.count : 0
    });

  } catch (err) {

    console.log("END ELECTION ERROR:", err);

    res.status(500).json({
      message: err.message
    });
  }
});

// ✅ Start Server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});