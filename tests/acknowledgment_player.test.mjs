import test from 'node:test'
import assert from 'node:assert/strict'
import { createAcknowledgmentPlayer } from '../apps/web/src/acknowledgmentPlayer.js'
import { shouldAcknowledge, afterAcknowledgment } from '../apps/web/src/acknowledgmentPolicy.js'

class Video extends EventTarget {
  duration=2; readyState=4; muted=true; currentTime=0; paused=true; calls=0; error=null
  play(){ this.calls++;this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve() }
  pause(){ this.paused=true }
}
function setup(options={}){
  const video=new Video(),live={muted:false},states=[],events=[]
  const player=createAcknowledgmentPlayer({video,getCompetingMedia:()=>[live],onState:s=>states.push(s),onEvent:e=>events.push(e),...options})
  return {player,video,live,states,events}
}
test('cue requires explicit consistent server decision',()=>{
  const positive={avatar_cue:{id:'acknowledge_ok_v1'},agent_decision:{response_intent:'acknowledge',action:'follow_up'}}
  assert.equal(shouldAcknowledge(positive),true)
  for(const override of [{invalid_answer:true},{should_finish:true},{recovered_messages:[]},{avatar_cue:{id:'none'}},{agent_decision:{response_intent:'challenge',action:'follow_up'}}]) assert.equal(shouldAcknowledge({...positive,...override}),false)
  assert.equal(shouldAcknowledge({}),false)
  assert.equal(afterAcknowledgment('好的。请介绍你的思路。'),'请介绍你的思路。')
  assert.equal(afterAcknowledgment('好的问题需要深入思考。'),'好的问题需要深入思考。')
})
test('play once; mute live only until ended; no duplicate same key',async()=>{
  const {player,video,live,states}=setup()
  const result=player.play({key:'one'})
  assert.equal(live.muted,true);assert.equal(video.muted,false)
  video.dispatchEvent(new Event('ended'))
  assert.equal(await result,'completed');assert.equal(live.muted,false);assert.equal(video.muted,true)
  assert.deepEqual(states,['loading','playing','idle'])
  assert.equal(await player.play({key:'one'}),'skipped');assert.equal(video.calls,1)
})
test('pause cancels and restores audio without waiting two seconds',async()=>{
  const {player,video,live}=setup()
  const result=player.play({key:'one'});player.stop()
  assert.equal(await result,'cancelled');assert.equal(live.muted,false);assert.equal(video.paused,true)
  video.dispatchEvent(new Event('ended'));assert.equal(player.busy,false)
})
test('failed load and wrong clip duration do not lock interview',async()=>{
  const {player,video,live}=setup()
  video.play=()=>Promise.reject(new Error('NotAllowedError'))
  assert.equal(await player.play({key:'blocked'}),'play-blocked');assert.equal(live.muted,false)
  video.duration=10
  assert.equal(await player.play({key:'wrong-length'}),'invalid-media')
})
test('timeout and late play resolution cannot restart stale audio',async()=>{
  let timeout,late
  const {player,video,live}=setup({timers:{setTimeout:f=>{timeout=f;return 1},clearTimeout:()=>{}}})
  video.play=()=>new Promise(resolve=>{late=resolve})
  const pending=player.play({key:'slow'});timeout()
  assert.equal(await pending,'start-timeout');assert.equal(live.muted,false)
  video.paused=false;late();await Promise.resolve();assert.equal(video.paused,true);assert.equal(video.muted,true)
})
test('hidden and stale operation guards skip',async()=>{
  const {player,video}=setup({nowHidden:()=>true})
  assert.equal(await player.play({key:'hidden'}),'skipped');assert.equal(video.calls,0)
  const clean=setup();assert.equal(await clean.player.play({key:'stale',guard:()=>false}),'skipped')
})
