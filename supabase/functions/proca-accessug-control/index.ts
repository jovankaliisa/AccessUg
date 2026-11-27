import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{autoRefreshToken:false,persistSession:false}});
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info","Access-Control-Allow-Methods":"POST,OPTIONS","Content-Type":"application/json"};
const out=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:cors});
const clean=(v:unknown,n=500)=>String(v??"").trim().slice(0,n);
const fail=(m:string,s=400)=>Object.assign(new Error(m),{status:s});
async function actor(req:Request){
 const token=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");if(!token)throw fail("Sign in to ACCESS UG first.",401);
 const {data,error}=await db.auth.getUser(token);if(error||!data.user)throw fail("Your ACCESS UG session has expired.",401);
 const {data:profile,error:pe}=await db.from("profiles").select("id,full_name,role,school_id").eq("id",data.user.id).maybeSingle();if(pe)throw pe;
 if(!profile||!["administrator","school"].includes(profile.role))throw fail("PROCA is available to school administrators and ACCESS UG administrators.",403);
 if(profile.role==="school"&&!profile.school_id){
  const resolved=await db.rpc("school_find_by_user",{p_user_id:data.user.id});
  if(!resolved.error&&resolved.data)profile.school_id=resolved.data;
 }
 return {user:data.user,profile,isAdmin:profile.role==="administrator"};
}
async function linksFor(a:any,filter?:string){
 let q=db.from("schools").select("id,name,code,district,location,school_type,status,email,phone,created_by").order("name");
 if(!a.isAdmin){if(!a.profile.school_id)throw fail("Your school account is not linked to a school.",403);q=q.eq("id",a.profile.school_id);}
 else if(filter)q=q.eq("id",filter);
 const {data:schools,error}=await q;if(error)throw error;const links=[];
 for(const school of schools||[]){
  let {data:ps,error:pe}=await db.from("proca_schools").select("*").eq("access_school_id",school.id).maybeSingle();if(pe)throw pe;
  if(!ps){
   const ins=await db.from("proca_schools").insert({access_school_id:school.id,name:school.name,school_type:school.school_type||"School",country:"Uganda",district:school.district||"",phone:school.phone||"",school_email:school.email||("proca-"+school.id+"@accessug.local"),owner_user_id:school.created_by||a.user.id,status:"active",subscription_plan:"accessug",subscription_status:"active"}).select("*").single();
   if(ins.error)throw ins.error;ps=ins.data;
   await db.from("proca_device_events").insert({school_id:ps.id,event_type:"accessug_school_linked",details:{access_school_id:school.id,school_name:school.name}});
  }
  if(!a.isAdmin){
   const member=await db.from("proca_members").upsert({school_id:ps.id,user_id:a.user.id,full_name:a.profile.full_name||a.user.email||"School administrator",email:a.user.email||"",role:"school_admin",status:"active"},{onConflict:"user_id"});
   if(member.error)throw member.error;
  }
  links.push({accessSchool:school,procaSchool:ps});
 }
 return links;
}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});if(req.method!=="POST")return out({error:"POST required"},405);
 try{
  const a=await actor(req),p=await req.json(),action=clean(p.action,80),links=await linksFor(a,clean(p.access_school_id,80)||undefined);
  const selected=links.find((x:any)=>x.accessSchool.id===clean(p.access_school_id))||(links.length===1?links[0]:null);
  if(action==="workspace"){
   const result=[];
   for(const link of links){const sid=link.procaSchool.id;
    const [d,pol,apps,domains,groups,brand,events,students,agent,tokens]=await Promise.all([
     db.from("proca_devices").select("*").eq("school_id",sid).order("created_at",{ascending:false}),
     db.from("proca_policies").select("*").eq("school_id",sid).order("profile_type"),
     db.from("proca_app_whitelist").select("*").eq("school_id",sid).order("created_at",{ascending:false}),
     db.from("proca_blocked_domains").select("*").eq("school_id",sid).order("created_at",{ascending:false}),
     db.from("proca_device_groups").select("*").eq("school_id",sid).order("name"),
     db.from("proca_device_branding").select("*").eq("school_id",sid).maybeSingle(),
     db.from("proca_device_events").select("*").eq("school_id",sid).order("created_at",{ascending:false}).limit(100),
     db.from("students").select("id,first_name,last_name,student_number,class_id,class_level,status").eq("school_id",link.accessSchool.id).order("last_name"),
     db.from("proca_agent_configs").select("*").eq("school_id",sid),
     db.from("proca_enrollment_tokens").select("id,label,platform,profile_type,expires_at,max_uses,used_count,created_at,revoked_at").eq("school_id",sid).order("created_at",{ascending:false}).limit(50)
    ]);
    for(const r of [d,pol,apps,domains,groups,events,students,agent,tokens])if(r.error)throw r.error;
    result.push({accessSchool:link.accessSchool,procaSchool:link.procaSchool,devices:d.data||[],policies:pol.data||[],apps:apps.data||[],domains:domains.data||[],groups:groups.data||[],branding:brand.data||null,events:events.data||[],students:students.data||[],agentConfigs:agent.data||[],tokens:tokens.data||[]});
   }
   return out({ok:true,isPlatformAdmin:a.isAdmin,workspace:result});
  }
  if(!selected)throw fail("Choose a school workspace first.");
  const sid=selected.procaSchool.id;
  const log=async(type:string,details:Record<string,unknown>={},device?:string)=>{const {error}=await db.from("proca_device_events").insert({school_id:sid,device_id:device||null,event_type:type,details});if(error)throw error;};
  if(action==="save_policy"){
   const profile=clean(p.profile_type,20);if(!["student","teacher","shared"].includes(profile))throw fail("Invalid device profile.");
   const keys=["lockdown_enabled","allow_task_manager","allow_control_panel","allow_settings","allow_powershell","allow_command_prompt","allow_usb_storage","allow_windows_store","allow_task_switching","block_social_media","enforce_browser_profile"];
   const flags:Record<string,boolean>={};for(const k of keys)flags[k]=p.policy?.[k]===true;
   const {data,error}=await db.from("proca_policies").upsert({school_id:sid,profile_type:profile,name:clean(p.name)||profile+" policy",...flags,block_harmful_content:p.policy?.block_harmful_content!==false,allow_school_apps:p.policy?.allow_school_apps!==false,restrict_games:p.policy?.restrict_games!==false,allow_microsoft_365:p.policy?.allow_microsoft_365!==false,allow_accessug:p.policy?.allow_accessug!==false,blocked_sites:Array.isArray(p.policy?.blocked_sites)?p.policy.blocked_sites.map((x:unknown)=>clean(x,253)).filter(Boolean).slice(0,300):[],allowed_sites:Array.isArray(p.policy?.allowed_sites)?p.policy.allowed_sites.map((x:unknown)=>clean(x,253)).filter(Boolean).slice(0,300):[],allowed_apps:Array.isArray(p.policy?.allowed_apps)?p.policy.allowed_apps.map((x:unknown)=>clean(x,160)).filter(Boolean).slice(0,300):[],blocked_apps:Array.isArray(p.policy?.blocked_apps)?p.policy.blocked_apps.map((x:unknown)=>clean(x,160)).filter(Boolean).slice(0,300):[],updated_by:a.user.id,updated_at:new Date().toISOString()},{onConflict:"school_id,profile_type"}).select("*").single();
   if(error)throw error;
   const linked=await db.from("proca_devices").update({policy_id:data.id,updated_at:new Date().toISOString()}).eq("school_id",sid).eq("profile_type",profile);
   if(linked.error)throw linked.error;
   await log("policy_updated",{profile_type:profile,devices_updated:linked.count??null});return out({ok:true,policy:data});
  }
  if(action==="create_device"){
   const platform=clean(p.platform,20),profile=clean(p.profile_type,20),name=clean(p.device_name,160);if(!["windows","android"].includes(platform)||!["student","teacher","shared"].includes(profile)||!name)throw fail("Enter a device name and valid platform/profile.");
   const policy=await db.from("proca_policies").select("id").eq("school_id",sid).eq("profile_type",profile).maybeSingle();
   if(policy.error)throw policy.error;
   const {data,error}=await db.from("proca_devices").insert({school_id:sid,policy_id:policy.data?.id||null,device_name:name,device_code:clean(p.device_code,80)||"AU-"+crypto.randomUUID().slice(0,8).toUpperCase(),platform,profile_type:profile,os_version:clean(p.os_version,80)||null,location:clean(p.location,160)||null,assigned_user_email:clean(p.assigned_user_email,254)||null,assigned_student_id:clean(p.assigned_student_id,80)||null,group_id:clean(p.group_id,80)||null,status:"pending"}).select("*").single();
   if(error)throw error;await log("device_enrolled",{device_name:name,platform,profile_type:profile},data.id);return out({ok:true,device:data});
  }
  if(action==="update_device"){
   const patch:Record<string,unknown>={};for(const k of ["device_name","location","assigned_user_email","assigned_student_id","group_id","profile_type","status"])if(k in (p.patch||{}))patch[k]=p.patch[k]||null;
   patch.updated_at=new Date().toISOString();const {data,error}=await db.from("proca_devices").update(patch).eq("id",clean(p.id,80)).eq("school_id",sid).select("*").single();if(error)throw error;
   await log("device_updated",{fields:Object.keys(patch)},data.id);return out({ok:true,device:data});
  }
  if(action==="delete_device"){const {error}=await db.from("proca_devices").delete().eq("id",clean(p.id,80)).eq("school_id",sid);if(error)throw error;await log("device_removed",{id:p.id});return out({ok:true});}
  if(action==="create_group"){const name=clean(p.name,120);if(!name)throw fail("Group name required.");const {data,error}=await db.from("proca_device_groups").insert({school_id:sid,name,description:clean(p.description,500)||null}).select("*").single();if(error)throw error;await log("device_group_created",{name});return out({ok:true,group:data});}
  if(action==="delete_group"){const {error}=await db.from("proca_device_groups").delete().eq("id",clean(p.id,80)).eq("school_id",sid);if(error)throw error;await log("device_group_deleted",{id:p.id});return out({ok:true});}
  if(action==="create_app"){const name=clean(p.display_name,160),platform=clean(p.platform,20),exe=clean(p.executable_name,160).toLowerCase();if(!name||!exe||!["windows","android","any"].includes(platform))throw fail("Complete app name, platform and executable/package.");const {data,error}=await db.from("proca_app_whitelist").insert({school_id:sid,display_name:name,platform,executable_name:exe,package_id:platform==="android"?exe:null,executable_path:clean(p.executable_path,500)||null,publisher:clean(p.publisher,160)||null,created_by:a.user.id}).select("*").single();if(error)throw error;await log("app_whitelisted",{name,platform});return out({ok:true,app:data});}
  if(action==="update_app"){const patch:Record<string,unknown>={};for(const k of ["enabled","display_name","executable_name","publisher","executable_path"])if(k in(p.patch||{}))patch[k]=p.patch[k];patch.updated_at=new Date().toISOString();const {data,error}=await db.from("proca_app_whitelist").update(patch).eq("id",clean(p.id,80)).eq("school_id",sid).select("*").single();if(error)throw error;await log("app_rule_updated",{id:p.id});return out({ok:true,app:data});}
  if(action==="delete_app"){const {error}=await db.from("proca_app_whitelist").delete().eq("id",clean(p.id,80)).eq("school_id",sid);if(error)throw error;await log("app_rule_deleted",{id:p.id});return out({ok:true});}
  if(action==="create_domain"){const domain=clean(p.domain,253).toLowerCase().replace(/^https?:\/\//,"").replace(/\/$/,"");if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)||domain.includes(".."))throw fail("Enter a valid domain only.");const {data,error}=await db.from("proca_blocked_domains").insert({school_id:sid,domain,category:clean(p.category,30)||"custom",action:clean(p.rule_action,10)==="allow"?"allow":"block",reason:clean(p.reason,500)||null,created_by:a.user.id}).select("*").single();if(error)throw error;await log("domain_rule_created",{domain});return out({ok:true,domain:data});}
  if(action==="update_domain"){const patch:Record<string,unknown>={};for(const k of ["enabled","action","category","reason"])if(k in(p.patch||{}))patch[k]=p.patch[k];const {data,error}=await db.from("proca_blocked_domains").update(patch).eq("id",clean(p.id,80)).eq("school_id",sid).select("*").single();if(error)throw error;await log("domain_rule_updated",{id:p.id});return out({ok:true,domain:data});}
  if(action==="delete_domain"){const {error}=await db.from("proca_blocked_domains").delete().eq("id",clean(p.id,80)).eq("school_id",sid);if(error)throw error;await log("domain_rule_deleted",{id:p.id});return out({ok:true});}
  if(action==="save_branding"){const primary=clean(p.primary_color,7),accent=clean(p.accent_color,7);if(!/^#[0-9a-f]{6}$/i.test(primary)||!/^#[0-9a-f]{6}$/i.test(accent))throw fail("Use valid six-digit hex colours.");const {data,error}=await db.from("proca_device_branding").upsert({school_id:sid,organization_name:clean(p.organization_name,160)||null,primary_color:primary,accent_color:accent,logo_url:clean(p.logo_url,1000)||null,wallpaper_url:clean(p.wallpaper_url,1000)||null,login_message:clean(p.login_message,500)||null,show_device_badge:p.show_device_badge!==false,updated_by:a.user.id,updated_at:new Date().toISOString()},{onConflict:"school_id"}).select("*").single();if(error)throw error;await log("device_branding_updated",{});return out({ok:true,branding:data});}
  if(action==="save_agent_config"){const platform=clean(p.platform,20);if(!["windows","android"].includes(platform))throw fail("Invalid platform.");const {data,error}=await db.from("proca_agent_configs").upsert({school_id:sid,platform,config:p.config||{},updated_by:a.user.id,updated_at:new Date().toISOString()},{onConflict:"school_id,platform"}).select("*").single();if(error)throw error;await log("agent_config_updated",{platform});return out({ok:true,config:data});}
  if(action==="issue_token"){const platform=clean(p.platform,20),profile=clean(p.profile_type,20),uses=Number(p.max_uses||1);if(!["windows","android","any"].includes(platform)||!["student","teacher","shared"].includes(profile)||!Number.isInteger(uses)||uses<1||uses>500)throw fail("Invalid enrollment token options.");const bytes=crypto.getRandomValues(new Uint8Array(32)),raw=btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw)))).map(x=>x.toString(16).padStart(2,"0")).join("");const {data,error}=await db.from("proca_enrollment_tokens").insert({school_id:sid,token_hash:hash,label:clean(p.label,120)||"Device enrollment",platform,profile_type:profile,max_uses:uses,expires_at:new Date(Date.now()+Math.min(Number(p.expiry_hours||24),168)*3600000).toISOString(),created_by:a.user.id}).select("id,label,platform,profile_type,expires_at,max_uses,used_count").single();if(error)throw error;await log("enrollment_token_created",{token_id:data.id});return out({ok:true,enrollment:{...data,token:raw}});}
  if(action==="revoke_token"){const {error}=await db.from("proca_enrollment_tokens").update({revoked_at:new Date().toISOString()}).eq("id",clean(p.id,80)).eq("school_id",sid);if(error)throw error;await log("enrollment_token_revoked",{id:p.id});return out({ok:true});}
  throw fail("Unknown PROCA action.");
 }catch(e){return out({error:e instanceof Error?e.message:"Request failed."},(e as {status?:number})?.status||400);}
});