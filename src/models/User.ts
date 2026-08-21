import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  avatar?: string;
  bio?: string;
  isAnonymous: boolean;
  trustScore: number;
  googleId?: string;
  location?: {
    type: string;
    coordinates: number[];
  };
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String },
    avatar: { type: String },
    bio: { type: String, default: '' },
    isAnonymous: { type: Boolean, default: false },
    trustScore: { type: Number, default: 50, min: 0, max: 100 },
    googleId: { type: String },
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number],
      }
    }
  },
  {
    timestamps: true,
  }
);

UserSchema.index({ location: '2dsphere' });

export const User = mongoose.model<IUser>('User', UserSchema);
