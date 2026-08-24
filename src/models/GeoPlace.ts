import mongoose, { Document, Schema } from 'mongoose';

export interface IGeoPlace extends Document {
  /** Unique lookup key, e.g. "list|nigeria|lagos" or "coord|nigeria|lagos|ikeja" */
  key: string;
  kind: 'list' | 'coord';
  country?: string;
  state?: string;
  name?: string;
  /** For kind = 'list': full area names */
  items?: string[];
  /** For kind = 'coord': [lng, lat] */
  coordinates?: number[];
  source?: string;
  createdAt: Date;
}

const GeoPlaceSchema: Schema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['list', 'coord'], required: true },
    country: { type: String },
    state: { type: String },
    name: { type: String },
    items: { type: [String] },
    coordinates: { type: [Number] },
    source: { type: String },
  },
  { timestamps: true }
);

export const GeoPlace = mongoose.model<IGeoPlace>('GeoPlace', GeoPlaceSchema);
