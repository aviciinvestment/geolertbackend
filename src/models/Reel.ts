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
  location?: {
    type: string;
    coordinates: number[];
  };
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
    },
    coordinates: {
      type: [Number],
    }
  },
  createdAt: { type: Date, default: Date.now }
});

ReelSchema.index({ location: '2dsphere' });

export default mongoose.model<IReel>('Reel', ReelSchema);
