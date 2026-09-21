import mongoose from 'mongoose';
export default mongoose.model('Customer',new mongoose.Schema({name:{type:String,trim:true,default:'WhatsApp customer'},phone:{type:String,required:true,unique:true,index:true},email:{type:String,trim:true,lowercase:true},notes:{type:String,default:''}},{timestamps:true}));
