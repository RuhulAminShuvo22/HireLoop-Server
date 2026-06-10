
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const { MongoClient, ServerApiVersion } = require("mongodb");

// Config
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB URI
const uri = process.env.MONGO_DB_URI;

// Mongo Client
const client = new MongoClient(uri, {
serverApi: {
version: ServerApiVersion.v1,
strict: true,
deprecationErrors: true,
},
});

async function run() {
try {
await client.connect();

console.log("✅ MongoDB Connected Successfully");

// Database
const db = client.db("hireloop");

// Collections
const usersCollection = db.collection("users");
const jobsCollection = db.collection("jobs");
const applicationsCollection = db.collection("applications");

// ==========================
// Users API
// ==========================

app.post("/users", async (req, res) => {
  try {
    const user = req.body;

    const existingUser = await usersCollection.findOne({
      email: user.email,
    });

    if (existingUser) {
      return res.status(200).send({
        success: false,
        message: "User already exists",
      });
    }

    const result = await usersCollection.insertOne(user);

    res.send({
      success: true,
      result,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: error.message,
    });
  }
});

app.get("/users", async (req, res) => {
  const result = await usersCollection.find().toArray();
  res.send(result);
});

// ==========================
// Root Route
// ==========================

app.get("/", (req, res) => {
  res.send("🚀 HireLoop Server Running...");
});

// Ping Test
await client.db("admin").command({ ping: 1 });

console.log("✅ MongoDB Ping Successful");


} catch (error) {
console.error(error);
}
}

run().catch(console.dir);

// Start Server
app.listen(PORT, () => {
console.log(`🚀 Server running on port ${PORT}`);
});
