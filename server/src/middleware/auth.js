import jwt from 'jsonwebtoken';
export function requireAuth(req,res,next){const token=req.get('authorization')?.replace('Bearer ','');if(!token)return res.status(401).json({error:{message:'Authentication required.'}});try{req.user=jwt.verify(token,process.env.SESSION_SECRET);next();}catch{return res.status(401).json({error:{message:'Invalid or expired token.'}})}}
export const requireAdmin=(req,res,next)=>req.user?.role==='ADMIN'?next():res.status(403).json({error:{message:'Administrator access required.'}});
