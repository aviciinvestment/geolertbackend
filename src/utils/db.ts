import mongoose from 'mongoose';

export const connectDB = async () => {
  try {
    // If running without a MongoDB URI (e.g. initial setup), warn but don't crash
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/geolert-reels';
    await mongoose.connect(uri);
    console.log(`MongoDB Connected: ${uri}`);
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    throw error;
  }
};
