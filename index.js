const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");

// ==========================
// Config
// ==========================
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    const applicationsCollection = db.collection("applications");
    const paymentsCollection = db.collection("payments");

    // ==========================
    // Subscription Plans
    // ==========================

    const plans = {
      "job-pro": {
        name: "Job Pro",
        amount: 1900,
      },

      "job-premium": {
        name: "Job Premium",
        amount: 3900,
      },

      "recruiter-growth": {
        name: "Recruiter Growth",
        amount: 4900,
      },

      "recruiter-enterprise": {
        name: "Recruiter Enterprise",
        amount: 14900,
      },
    };

    // ==========================
    // Database Indexes
    // ==========================

    await usersCollection.createIndex({ email: 1 }, { unique: true });

    // Compound Unique Index
    await companiesCollection.createIndex(
      {
        ownerEmail: 1,
        companyName: 1,
      },
      {
        unique: true,
      },
    );

    // ======================================
    // STRIPE CHECKOUT SESSION
    // ======================================

    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { planId, userEmail } = req.body;

        const selectedPlan = plans[planId];

        if (!selectedPlan) {
          return res.status(400).send({
            success: false,
            message: "Invalid plan selected",
          });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],

          line_items: [
            {
              price_data: {
                currency: "usd",

                product_data: {
                  name: selectedPlan.name,
                },

                unit_amount: selectedPlan.amount,
              },

              quantity: 1,
            },
          ],

          // User and plan information
          metadata: {
            planId,
            userEmail,
          },

          mode: "payment",

          success_url:
            "http://localhost:3000/pricing/success?session_id={CHECKOUT_SESSION_ID}",

          cancel_url: "http://localhost:3000/pricing",
        });

        res.send({
          success: true,
          url: session.url,
        });
      } catch (error) {
        console.error("Stripe Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });
    // ======================================
    //verify-payment
    // ======================================
    app.get("/verify-payment", async (req, res) => {
      try {
        const { session_id } = req.query;

        if (!session_id) {
          return res.status(400).send({
            success: false,
            message: "Session ID is required",
          });
        }

        // Duplicate payment protection
        const existingPayment = await paymentsCollection.findOne({
          stripeSessionId: session_id,
        });

        if (existingPayment) {
          return res.send({
            success: true,
            message: "Payment already verified",
          });
        }

        // Get payment information from Stripe
        const stripeSession =
          await stripe.checkout.sessions.retrieve(session_id);

        // Payment success check
        if (stripeSession.payment_status !== "paid") {
          return res.status(400).send({
            success: false,
            message: "Payment not completed",
          });
        }

        // Get metadata
        const userEmail = stripeSession.metadata.userEmail;
        const planId = stripeSession.metadata.planId;

        if (!userEmail || !planId) {
          return res.status(400).send({
            success: false,
            message: "Invalid payment metadata",
          });
        }

        // Update user subscription
        await usersCollection.updateOne(
          {
            email: userEmail,
          },
          {
            $set: {
              subscriptionPlan: planId,
              subscriptionStatus: "active",
              upgradedAt: new Date(),
            },
          },
        );

        // Save payment history
        await paymentsCollection.insertOne({
          userEmail,
          planId,
          stripeSessionId: session_id,
          amount: stripeSession.amount_total / 100,
          currency: stripeSession.currency,
          paymentStatus: stripeSession.payment_status,
          paidAt: new Date(),
        });

        res.send({
          success: true,
          message: "Payment verified and account upgraded",
        });
      } catch (error) {
        console.error("Verify Payment Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ======================================
    // MY BILLING INFORMATION
    // ======================================

    app.get("/my-billing", async (req, res) => {
      try {
        const { email } = req.query;

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Email is required",
          });
        }

        // Find user
        const user = await usersCollection.findOne(
          {
            email,
          },
          {
            projection: {
              subscriptionPlan: 1,
              subscriptionStatus: 1,
              upgradedAt: 1,
            },
          },
        );

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        // Get payment history
        const payments = await paymentsCollection
          .find({
            userEmail: email,
          })
          .sort({
            paidAt: -1,
          })
          .toArray();

        res.send({
          success: true,

          subscription: {
            plan: user.subscriptionPlan || "Free",

            status: user.subscriptionStatus || "inactive",

            upgradedAt: user.upgradedAt || null,
          },

          payments,
        });
      } catch (error) {
        console.error("Billing Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

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

    // Update User Profile
    app.patch("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const { name, image } = req.body;

        const result = await usersCollection.updateOne(
          {
            email,
          },
          {
            $set: {
              name,
              image,
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        res.send({
          success: true,
          modifiedCount: result.modifiedCount,
          message: "Profile updated successfully",
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ================================================
    // JOBS API
    // ================================================

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
        if (!ObjectId.isValid(job.companyId)) {
          return res.status(400).send({
            success: false,
            message: "Invalid Company ID",
          });
        }

        const company = await companiesCollection.findOne({
          _id: new ObjectId(job.companyId),
        });

        if (!company) {
          return res.status(404).send({
            success: false,
            message: "Company not found",
          });
        }

        if (!company.isApproved) {
          return res.status(403).send({
            success: false,
            message: "Company is not approved yet",
          });
        }

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

    // ==================================================
    // Get Recruiter's Jobs
    // ==================================================

    app.get("/recruiter/jobs/:email", async (req, res) => {
      try {
        const email = req.params.email;

        // Recruiter exists?
        const recruiter = await usersCollection.findOne({
          email,
        });

        if (!recruiter) {
          return res.status(404).send({
            success: false,
            message: "Recruiter not found",
          });
        }

        // Get recruiter's jobs
        const jobs = await jobsCollection
          .find({
            recruiterEmail: email,
          })
          .sort({
            createdAt: -1,
          })
          .toArray();

        // Attach company info
        const jobsWithCompany = await Promise.all(
          jobs.map(async (job) => {
            let company = null;

            if (ObjectId.isValid(job.companyId)) {
              company = await companiesCollection.findOne({
                _id: new ObjectId(job.companyId),
              });
            }

            return {
              ...job,
              company,
            };
          }),
        );

        res.send({
          success: true,
          count: jobsWithCompany.length,
          jobs: jobsWithCompany,
        });
      } catch (error) {
        console.error("Recruiter Jobs Error:", error);

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

    // =================================================
    // COMPANY API
    // =================================================

    // Register Company
    app.post("/companies", async (req, res) => {
      try {
        const company = req.body;

        // Required Fields
        if (!company.companyName || !company.ownerEmail) {
          return res.status(400).send({
            success: false,
            message: "Company name and owner email are required",
          });
        }

        // User Exists?
        const user = await usersCollection.findOne({
          email: company.ownerEmail,
        });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        // Only Recruiters Can Register Companies
        if (user.role !== "recruiter") {
          return res.status(403).send({
            success: false,
            message: "Only recruiters can register companies",
          });
        }

        // Company Name Already Exists
        const existingCompanyName = await companiesCollection.findOne({
          companyName: company.companyName,
        });

        if (existingCompanyName) {
          return res.status(400).send({
            success: false,
            message: "Company name already exists",
          });
        }

        // Same Owner + Same Company Name Check
        const existingCompany = await companiesCollection.findOne({
          ownerEmail: company.ownerEmail,
          companyName: company.companyName,
        });

        if (existingCompany) {
          return res.status(409).send({
            success: false,
            message: "You already registered this company",
          });
        }

        // Create Company
        const result = await companiesCollection.insertOne({
          ...company,

          isApproved: false,

          jobsPosted: 0,

          jobLimit: 3,

          plan: "Free",

          createdAt: new Date(),

          updatedAt: new Date(),
        });

        res.send({
          success: true,
          insertedId: result.insertedId,
          message: "Company registered successfully",
        });
      } catch (error) {
        console.error("Company Registration Error:", error);

        // MongoDB Duplicate Key Error
        if (error.code === 11000) {
          return res.status(400).send({
            success: false,
            message: "Duplicate company information detected",
          });
        }

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });
    // Get All Companies//
    app.get("/companies", async (req, res) => {
      try {
        const { status } = req.query;

        let query = {};

        // Approved Companies
        if (status === "approved") {
          query.isApproved = true;
        }

        // Pending Companies
        if (status === "pending") {
          query.isApproved = false;
        }

        const companies = await companiesCollection
          .find(query)
          .sort({
            createdAt: -1,
          })
          .toArray();

        res.send({
          success: true,
          count: companies.length,
          companies,
        });
      } catch (error) {
        console.error("Get Companies Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Get Company By Owner Email
    app.get("/companies/owner/:email", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Email is required",
          });
        }

        const company = await companiesCollection.findOne({
          ownerEmail: email,
        });

        if (!company) {
          return res.status(404).send({
            success: false,
            message: "Company not found",
          });
        }

        res.send({
          success: true,
          company,
        });
      } catch (error) {
        console.error("Get Company By Owner Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Get Single Company
    app.get("/companies/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // Validate Company ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid company ID",
          });
        }

        const company = await companiesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!company) {
          return res.status(404).send({
            success: false,
            message: "Company not found",
          });
        }

        res.send({
          success: true,
          company,
        });
      } catch (error) {
        console.error("Get Company Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Update Company
    app.patch("/companies/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // Validate Company ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid company ID",
          });
        }

        const updatedCompany = req.body;

        // Protected Fields
        delete updatedCompany._id;
        delete updatedCompany.ownerEmail;
        delete updatedCompany.isApproved;
        delete updatedCompany.plan;
        delete updatedCompany.jobsPosted;
        delete updatedCompany.jobLimit;
        delete updatedCompany.createdAt;

        const result = await companiesCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: {
              ...updatedCompany,
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Company not found",
          });
        }

        res.send({
          success: true,
          modifiedCount: result.modifiedCount,
          message: "Company updated successfully",
        });
      } catch (error) {
        console.error("Update Company Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Approve Company (Admin Only)
    app.patch("/companies/approve/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { adminEmail } = req.body;

        // Validate Company ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid company ID",
          });
        }

        // Admin Email Required
        if (!adminEmail) {
          return res.status(400).send({
            success: false,
            message: "Admin email is required",
          });
        }

        // Check Admin
        const admin = await usersCollection.findOne({
          email: adminEmail,
        });

        if (!admin) {
          return res.status(404).send({
            success: false,
            message: "Admin not found",
          });
        }

        if (admin.role !== "admin") {
          return res.status(403).send({
            success: false,
            message: "Only admins can approve companies",
          });
        }

        // Check Company Exists
        const company = await companiesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!company) {
          return res.status(404).send({
            success: false,
            message: "Company not found",
          });
        }

        // Already Approved?
        if (company.isApproved) {
          return res.status(400).send({
            success: false,
            message: "Company is already approved",
          });
        }

        const result = await companiesCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: {
              isApproved: true,
              approvedAt: new Date(),
              approvedBy: adminEmail,
              updatedAt: new Date(),
            },
          },
        );

        res.send({
          success: true,
          modifiedCount: result.modifiedCount,
          message: "Company approved successfully",
        });
      } catch (error) {
        console.error("Approve Company Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Delete Company
    app.delete("/companies/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // Validate ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid company ID",
          });
        }

        // Check company exists
        const company = await companiesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!company) {
          return res.status(404).send({
            success: false,
            message: "Company not found",
          });
        }

        // OPTIONAL SAFETY: delete related jobs first
        await jobsCollection.deleteMany({
          companyId: id,
        });

        // Delete company
        const result = await companiesCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send({
          success: true,
          deletedCount: result.deletedCount,
          message: "Company and related jobs deleted successfully",
        });
      } catch (error) {
        console.error("Delete Company Error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ===========================
    // APPLICATIONS API
    // ===========================

    // Create Application
    app.post("/applications", async (req, res) => {
      try {
        const application = req.body;

        const result = await db.collection("applications").insertOne({
          ...application,
          createdAt: new Date(),
        });

        res.send({
          success: true,
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // Get All Applications
    app.get("/applications", async (req, res) => {
      try {
        const applications = await db
          .collection("applications")
          .find()
          .sort({ createdAt: -1 })
          .toArray();

        res.send({
          success: true,
          count: applications.length,
          applications,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    //Apply Job (POST)
    app.post("/applications", async (req, res) => {
      try {
        const application = req.body;

        // Required check
        if (!application.jobId || !application.applicantEmail) {
          return res.status(400).send({
            success: false,
            message: "Job ID and Applicant Email required",
          });
        }

        // Prevent duplicate apply
        const existing = await applicationsCollection.findOne({
          jobId: application.jobId,
          applicantEmail: application.applicantEmail,
        });

        if (existing) {
          return res.status(409).send({
            success: false,
            message: "You already applied for this job",
          });
        }

        const result = await applicationsCollection.insertOne({
          ...application,
          createdAt: new Date(),
        });

        res.send({
          success: true,
          insertedId: result.insertedId,
          message: "Application submitted successfully",
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    //Get Applications (Recruiter)
    app.get("/applications/recruiter/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const applications = await applicationsCollection
          .find({ recruiterEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send({
          success: true,
          count: applications.length,
          applications,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    //Get Applications (Applicant)//
    app.get("/applications/applicant/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const applications = await applicationsCollection
          .find({ applicantEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send({
          success: true,
          count: applications.length,
          applications,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    //4. Update Status (Accept / Reject)
    app.patch("/applications/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid application ID",
          });
        }

        const result = await applicationsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status,
              updatedAt: new Date(),
            },
          },
        );

        res.send({
          success: true,
          modifiedCount: result.modifiedCount,
          message: "Application status updated",
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
    // ===========================
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
