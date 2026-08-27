import mongoose, { Document, Schema } from 'mongoose';

export type UserRole = 'user' | 'authority' | 'admin' | 'superadmin';
export type AuthorizationStatus = 'pending' | 'approved' | 'rejected';

export interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  avatar?: string;
  bio?: string;
  isAnonymous: boolean;
  trustScore: number;
  role: UserRole;
  authorizationStatus: AuthorizationStatus;
  specialization?: string;
  authorizedBy?: mongoose.Types.ObjectId;
  jurisdiction?: {
    country?: string;
    state?: string;
    lga?: string;
  };
  region?: {
    country?: string;
    state?: string;
    lga?: string;
  };
  regionTaggedAt?: Date;
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
    role: {
      type: String,
      enum: ['user', 'authority', 'admin', 'superadmin'],
      default: 'user',
    },
    authorizationStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved',
    },
    specialization: { type: String },
    authorizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    jurisdiction: {
      country: { type: String },
      state: { type: String },
      lga: { type: String },
    },
    region: {
      country: { type: String },
      state: { type: String },
      lga: { type: String },
    },
    regionTaggedAt: { type: Date },
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
