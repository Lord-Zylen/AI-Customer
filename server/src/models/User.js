import mongoose from 'mongoose';
export default mongoose.model('User',new mongoose.Schema({name:{type:String,required:true,trim:true},email:{type:String,required:true,unique:true,lowercase:true,trim:true},passwordHash:{type:String,required:true},role:{type:String,enum:['ADMIN','STAFF'],default:'STAFF'}},{timestamps:true}));
