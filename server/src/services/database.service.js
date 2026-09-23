import mongoose from 'mongoose';
export async function connectDatabase(){if(!process.env.MONGODB_URI)throw new Error('MONGODB_URI is not configured.');await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000});return mongoose.connection;}
export const databaseStatus=()=>mongoose.connection.readyState===1?'CONNECTED':'NOT CONNECTED';
export async function closeDatabase(){await mongoose.connection.close();}
