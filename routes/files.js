const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");
const File = require("../models/File");
const authenticateUser = require("../Middleware/authUserid");
const admin = require("../firebaseAdmin");
const User = require("../models/User");
const Transaction = require("../models/transcation");
const ensureUserExists = require("../Middleware/ensureUserExist");

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

let bucket;
mongoose.connection.once("open", () => {
    bucket = new GridFSBucket(mongoose.connection.db, { bucketName: "uploads" });
    console.log("GridFSBucket Connected!");
});

const CREDIT_REWARD = 10;
const DOWNLOAD_COST = 5;



// Upload File
router.post("/upload", authenticateUser, ensureUserExists, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded." });
        const user = req.dbUser;
        
        const uploadStream = bucket.openUploadStream(req.file.originalname, {
            contentType: req.file.mimetype,
            metadata: { userId: user._id.toString() },
        });

        uploadStream.end(req.file.buffer);
        uploadStream.on("finish", async () => {
            const newFile = new File({
                fileID: uploadStream.id,
                fileName: req.file.originalname,
                uploadedBy: user._id,
                size: req.file.size,
                fileType: req.file.mimetype,
                description: req.body.description || "",
                uploadDate: new Date(),
            });

            await newFile.save();
            user.credits += CREDIT_REWARD;
            await user.save();

            const transaction = new Transaction({
                userId: user._id,
                amount: CREDIT_REWARD,
                type: "credit",
                description: `Earned credits for uploading "${req.file.originalname}"`,
                date: new Date(),
            });
            await transaction.save();

            res.status(201).json({
                message: "✅ File uploaded successfully, credits awarded",
                file: { id: uploadStream.id, filename: req.file.originalname },
                credits: user.credits,
            });
        });
    } catch (error) {
        console.error("❌ Upload Error:", error);
        res.status(500).json({ error: "File upload failed" });
    }
});

// Get All Files with Filters
router.get("/all", authenticateUser, async (req, res) => {
    try {
        let { fileType, minSize, maxSize, sortBy } = req.query;
        let filter = {};

        if (fileType) filter.fileType = fileType;
        if (minSize || maxSize) {
            filter.size = {};
            if (minSize) filter.size.$gte = parseInt(minSize);
            if (maxSize) filter.size.$lte = parseInt(maxSize);
        }

        let sortOption = { uploadDate: -1 };
        if (sortBy === "oldest") sortOption.uploadDate = 1;
        else if (sortBy === "most_downloads") sortOption = { downloads: -1 };
        else if (sortBy === "most_likes") sortOption = { likes: -1 };

        const files = await File.find(filter).sort(sortOption);
        const userIDs = files.map(file => file.uploadedBy);
        const users = await User.find({ _id: { $in: userIDs } }).select("email");
        const emailMap = Object.fromEntries(users.map(user => [user._id.toString(), user.email]));
        
        res.json(files.map(file => ({
            ...file.toObject(),
            uploadedBy: emailMap[file.uploadedBy.toString()] || "Unknown",
        })));
    } catch (error) {
        console.error("❌ Error fetching files:", error);
        res.status(500).json({ error: "Error fetching files" });
    }
});

//  Get a File from GridFS
router.get("/uploads/:filename", async (req, res) => {
    try {
        const file = await mongoose.connection.db.collection("uploads.files").findOne({ filename: req.params.filename });

        if (!file) {
            return res.status(404).json({ error: "File not found" });
        }

        res.set("Content-Type", file.contentType);
        const readStream = bucket.openDownloadStream(file._id);
        readStream.pipe(res);
    } catch (err) {
        console.error(" Fetch Error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Download File
router.get("/download/:fileID", authenticateUser, async (req, res) => {
    try {
        const userId = req.user.uid;
        const fileID = req.params.fileID;
        const user = await User.findOne({ firebaseUID: userId });
        if (!user) return res.status(404).json({ error: "User not found" });
        const fileObjectId = new mongoose.Types.ObjectId(fileID);
        const alreadyDownloaded = user.downloadedFiles.some(file => file.equals(fileObjectId));
        if (!alreadyDownloaded && user.credits < DOWNLOAD_COST) {
            return res.status(403).json({ error: "Insufficient credits." });
        }

        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            if (!alreadyDownloaded) {
                const file = await File.findOne({ fileID: fileObjectId }).session(session);
                if (!file) {
                    return res.status(404).json({ error: "File not found" });
                }
                // Ensure user Id is not already in downloadeds array
                if(!file.downloads.some((id)=> id.equals(user._id))) {
                    file.downloads.push(user._id);
                    await file.save();
                    console.log("User ${user._id} added to dowloads array of file ${file._id}");
                }
                else {
                    console.log("User ${user._id} already exists in downloads array of file ${file._id}");
                }
                user.credits -= DOWNLOAD_COST;
                user.downloadedFiles.push(fileObjectId);
                await user.save({ session });
                await new Transaction({
                    userId: user._id,
                    amount: -DOWNLOAD_COST,
                    type: "debit",
                    description: `Downloaded file ID: ${fileID}`,
                    date: new Date(),
                }).save({ session });
            }
            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }

        const downloadStream = bucket.openDownloadStream(fileObjectId);
        res.set({ "Content-Disposition": `attachment; filename="downloaded_file"` });
        downloadStream.pipe(res);
    } catch (error) {
        console.error("❌ Download Error:", error);
        res.status(500).json({ error: "Error downloading file" });
    }
});


// Get Transactions history of a user 
router.get("/history", authenticateUser, async (req, res) => {
    try {
        console.log("🟢 Fetching Transaction History...");
        const user = await mongoose.model("User").findOne({ firebaseUID: req.user.uid });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Fetch last 10 transactions, sorted by latest first
        const transactions = await Transaction.find({ userId: user._id })
            .sort({ date: -1 })
            .limit(10);

        res.status(200).json({ transactions });
    } catch (error) {
        console.error("❌ Error Fetching Transactions:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});


// Report an Issue for a Dowloaded file 
router.post("/report/:fileID", authenticateUser, async (req, res) => {
    try {
        console.log("🟢 Report Route Hit!");
        const userId = req.user.uid;
        const fileID = req.params.fileID;
        console.log("🔹 Checking File ID:", fileID);

        if (!mongoose.Types.ObjectId.isValid(fileID)) {
            return res.status(400).json({ error: "Invalid file ID format" });
        }

        // Convert fileID to ObjectId if needed
        const fileObjectId = new mongoose.Types.ObjectId(fileID);

        // Fetch user from database
        const user = await User.findOne({ firebaseUID: userId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Fetch file from database
        const file = await File.findOne({ fileID: fileObjectId });
        if (!file) {
            return res.status(404).json({ error: "File not found" });
        }

        console.log("✅ File found:", file);

        // Check if the user has downloaded the file
        const hasDownloaded = user.downloadedFiles.some(downloadedFile =>
            downloadedFile.equals(fileObjectId)
        );

        if (!hasDownloaded) {
            return res.status(403).json({ error: "You can only report files you have downloaded." });
        }

        // Extract issue details from request body
        const { issueType, description } = req.body;

        // Add issue to the file document
        file.issues.push({
            userId: user._id,
            issueType,
            description,
            reportedAt: new Date()
        });

        await file.save();

        res.status(200).json({ message: "Issue reported successfully." });

    } catch (error) {
        console.error("❌ Error Reporting Issue:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Export router
module.exports = router;






















