const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// ==========================
// Config
// ==========================
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================
// Middleware
// ==========================
app.use(cors());
app.use(express.json());

// ==========================
// MongoDB URI
// ==========================
const uri = process.env.MONGO_DB_URI;

// ==========================
// Mongo Client
// ==========================
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

    // ==========================
    // Database
    // ==========================
    const db = client.db("hireloop");

    // ==========================
    // Collections
    // ==========================
    const usersCollection = db.collection("users");
    const jobsCollection = db.collection("jobs");
    const companiesCollection = db.collection("companies");

    // ==================================================
    // USERS API
    // ==================================================

    // Create User
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;

        const existingUser = await usersCollection.findOne({
          email: user.email,
        });

        if (existingUser) {
          return res.status(400).send({
            success: false,
            message: "User already exists",
          });
        }

        const result = await usersCollection.insertOne({
          ...user,
          createdAt: new Date(),
        });

        res.send({
          success: true,
          insertedId: result.insertedId,
          message: "User created successfully",
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Get All Users
    app.get("/users", async (req, res) => {
      try {
        const result = await usersCollection.find().toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Get Single User By Email
    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const result = await usersCollection.findOne({
          email,
        });

        res.send(result);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ==================================================
    // JOBS API
    // ==================================================

    // Create Job
    app.post("/jobs", async (req, res) => {
      try {
        const job = req.body;

        // Required fields
        if (
          !job.title ||
          !job.category ||
          !job.type ||
          !job.companyId ||
          !job.recruiterEmail
        ) {
          return res.status(400).send({
            success: false,
            message: "Missing required fields",
          });
        }

        // Recruiter check
        const recruiter = await usersCollection.findOne({
          email: job.recruiterEmail,
        });

        if (!recruiter) {
          return res.status(404).send({
            success: false,
            message: "Recruiter not found",
          });
        }

        if (recruiter.role !== "recruiter") {
          return res.status(403).send({
            success: false,
            message: "Only recruiters can post jobs",
          });
        }

        // Company check
        // if (!ObjectId.isValid(job.companyId)) {
        //   return res.status(400).send({
        //     success: false,
        //     message: "Invalid Company ID",
        //   });
        // }

        // const company = await companiesCollection.findOne({
        //   _id: new ObjectId(job.companyId),
        // });

        // if (!company) {
        //   return res.status(404).send({
        //     success: false,
        //     message: "Company not found",
        //   });
        // }

        // if (!company.isApproved) {
        //   return res.status(403).send({
        //     success: false,
        //     message: "Company is not approved yet",
        //   });
        // }

        // Insert Job
        const result = await jobsCollection.insertOne({
          ...job,

          status: job.status || "active",

          applicants: 0,

          views: 0,

          createdAt: new Date(),

          updatedAt: new Date(),
        });

        res.send({
          success: true,
          insertedId: result.insertedId,
          message: "Job posted successfully",
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Get All Jobs
    app.get("/jobs", async (req, res) => {
      try {
        const jobs = await jobsCollection
          .find({
            status: "active",
          })
          .sort({
            createdAt: -1,
          })
          .toArray();

        res.send(jobs);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Get Single Job
    app.get("/jobs/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // Validate ObjectId
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid Job ID",
          });
        }

        const job = await jobsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!job) {
          return res.status(404).send({
            success: false,
            message: "Job not found",
          });
        }

        res.send(job);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Update Job
    app.patch("/jobs/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // Validate ObjectId
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid Job ID",
          });
        }

        const updatedJob = req.body;

        const result = await jobsCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: {
              ...updatedJob,
              updatedAt: new Date(),
            },
          },
        );

        // Job not found
        if (result.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Job not found",
          });
        }

        res.send({
          success: true,
          modifiedCount: result.modifiedCount,
          message: "Job updated successfully",
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });
    // Delete Job
    app.delete("/jobs/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // Validate ObjectId
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid Job ID",
          });
        }

        const result = await jobsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        // Job not found
        if (result.deletedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Job not found",
          });
        }

        res.send({
          success: true,
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });
    // ===========================
    // Root Route
    // ==========================
    app.get("/", (req, res) => {
      res.send("🚀 HireLoop Server Running...");
    });

    // ==========================
    // MongoDB Ping Test
    // ==========================
    await client.db("admin").command({ ping: 1 });

    console.log("✅ MongoDB Ping Successful");
  } catch (error) {
    console.error("❌ MongoDB Connection Error:", error);
  }
}

run().catch(console.dir);

// ==========================
// Start Server
// ==========================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
