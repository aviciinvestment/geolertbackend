import mongoose, { Document, Schema } from 'mongoose';

export interface IReel extends Document {
  url: string;
  username: string;
  avatar: string;
  description: string;
  likes: number;
  comments: number;
  views: number;
  isLive: boolean;
  isAnonymous: boolean;
  viewers?: number;
  userId?: mongoose.Types.ObjectId;
  likedBy?: mongoose.Types.ObjectId[];
  location: {
    type: string;
    coordinates: number[];
  };
  aiAnalysis?: {
    summary: string;
    transcript: string;
    description: string;
    severityReason: string;
  };
  severity?: number;
  category?: string;
  status?: 'pending' | 'attended' | 'false_report';
  region?: {
    country?: string;
    state?: string;
    lga?: string;
    area?: string;
  };
  regionTagged?: boolean;
  linkedinPosted?: boolean;
  linkedinPostId?: string;
  linkedinPostUrl?: string;
  linkedinPostedAt?: Date;
  createdAt: Date;
}

const ReelSchema: Schema = new Schema({
  url: { type: String, required: true },
  username: { type: String, required: true, default: 'anonymous_user' },
  avatar: { type: String, required: true, default: 'https://i.pravatar.cc/150' },
  description: { type: String, default: '' },
  likes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  isLive: { type: Boolean, default: false },
  isAnonymous: { type: Boolean, default: false },
  viewers: { type: Number, default: 0 },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  likedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  location: {
    type: {
      type: String,
      enum: ['Point'],
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
    }
  },
  aiAnalysis: {
    summary: { type: String, default: '' },
    transcript: { type: String, default: '' },
    description: { type: String, default: '' },
    severityReason: { type: String, default: '' },
  },
  severity: { type: Number, default: 0, min: 0, max: 1 },
  category: { type: String, default: 'general' },
  status: { type: String, enum: ['pending', 'attended', 'false_report'], default: 'pending' },
  region: {
    country: { type: String },
    state: { type: String },
    lga: { type: String },
    area: { type: String },
  },
  regionTagged: { type: Boolean, default: false },
  linkedinPosted: { type: Boolean, default: false },
  linkedinPostId: { type: String, default: null },
  linkedinPostUrl: { type: String, default: null },
  linkedinPostedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

ReelSchema.index({ location: '2dsphere' });
ReelSchema.index({ 'region.country': 1, 'region.state': 1, 'region.lga': 1 });

export default mongoose.model<IReel>('Reel', ReelSchema);
