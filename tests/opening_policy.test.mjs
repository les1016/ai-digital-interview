import test from 'node:test'
import assert from 'node:assert/strict'
import { createAcknowledgmentPlayer } from '../apps/web/src/acknowledgmentPlayer.js'

test('long intro keeps exclusive audio until full clip ends', async () => {
  class Video extends EventTarget {
    duration=31.56;readyState=4;muted=true;currentTime=0;error=null
    pause(){} play(){this.dispatchEvent(new Event('playing')); return Promise.resolve()}
  }
  const video=new Video(),live={muted:false},delays=[]
  const player=createAcknowledgmentPlayer({video,getCompetingMedia:()=>[live],expectedDuration:31.56,startTimeoutMs:2500,playbackTimeoutMs:36560,timers:{setTimeout(fn,ms){delays.push(ms);return delays.length},clearTimeout(){}}})
  const result=player.play({key:'intro-1'})
  assert.equal(live.muted,true)
  assert.deepEqual(delays,[2500,36560])
  video.dispatchEvent(new Event('ended'))
  assert.equal(await result,'completed');assert.equal(live.muted,false)
})

test('administrator skip retains the exact media position and restores audio', async () => {
  class Video extends EventTarget {
    duration=31.56;readyState=4;muted=true;currentTime=0;error=null
    pause(){} play(){this.dispatchEvent(new Event('playing')); return Promise.resolve()}
  }
  const video=new Video(),live={muted:false},events=[]
  const player=createAcknowledgmentPlayer({video,getCompetingMedia:()=>[live],expectedDuration:31.56,onEvent:(event,details)=>events.push({event,...details})})
  const result=player.play({key:'skip-1'});video.currentTime=7.85;player.skip();player.skip()
  assert.equal(await result,'manual-skipped');assert.equal(live.muted,false)
  assert.equal(video.currentTime,0);assert.equal(player.busy,false)
  assert.deepEqual(events.at(-1),{event:'manual-skipped',key:'skip-1',positionSeconds:7.85,durationSeconds:31.56})
  assert.equal(events.filter(e=>e.event==='manual-skipped').length,1)
})
