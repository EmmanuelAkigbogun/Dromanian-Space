// Isolated development fixture; never accepts a remote connection string.
import {writeFileSync} from 'node:fs';
import {randomBytes,scryptSync} from 'node:crypto';
import {createUser,createWorkspace,createChannel,addMember,admin,q,pool} from '../tests/helpers/db.ts';
// Sign-in accepts only the API's scrypt format (api/auth.ts), not the test helper's bcrypt hash.
const scryptHash=(password:string)=>{const salt=randomBytes(16);return `scrypt$${salt.toString('base64url')}$${scryptSync(password,salt,64).toString('base64url')}`;};
const user=await createUser('preview-owner');const teammate=await createUser('preview-teammate');
for(const u of [user,teammate])await admin('UPDATE auth.users SET encrypted_password=$2 WHERE id=$1',[u.id,scryptHash('password123')]);
const workspace=await createWorkspace(user,'Dromanian Preview');await addMember(workspace,teammate);
const other=await createWorkspace(user,'Second Preview');
const channel=await createChannel(user,workspace,{name:'general'});
await admin('UPDATE profiles SET username=$2,display_name=$3 WHERE id=$1',[user.id,`preview-${user.id.slice(0,8)}`,'Preview Owner']);
await q(user,"SELECT drive_create_document($1,NULL,'Team handbook','Welcome to the isolated development workspace. Travel budget: EUR 180 per night.')",[workspace]);
writeFileSync('.local/preview.json',JSON.stringify({email:user.email,password:'password123',workspace,other,channel,userId:user.id},null,2));
console.log('Created isolated preview data; credentials in .local/preview.json.');await pool.end();
