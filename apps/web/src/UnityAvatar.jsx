import { useEffect, useRef, useState } from 'react'

const AVATAR_ROOT = '/unity-avatar'
const BUILD_NAME = 'unity-avatar'

function loadScript(source) {
  const existing = document.querySelector(`script[data-unity-avatar="${source}"]`)
  if (existing) {
    if (existing.dataset.loaded === 'true') return Promise.resolve()
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', resolve, { once: true })
      existing.addEventListener('error', reject, { once: true })
    })
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = source
    script.async = true
    script.dataset.unityAvatar = source
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true'
      resolve()
    }, { once: true })
    script.addEventListener('error', reject, { once: true })
    document.head.appendChild(script)
  })
}

function averageEnergy(data, start, end) {
  let sum = 0
  const upper = Math.min(data.length, end)
  for (let index = start; index < upper; index += 1) {
    const centered = (data[index] - 128) / 128
    sum += centered * centered
  }
  return Math.sqrt(sum / Math.max(1, upper - start))
}

export default function UnityAvatar({ audioRef, videoRef, speaking, onStatus }) {
  const canvasRef = useRef(null)
  const unityRef = useRef(null)
  const animationRef = useRef(0)
  const audioContextRef = useRef(null)
  const [available, setAvailable] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let cancelled = false
    const loaderUrl = `${AVATAR_ROOT}/Build/${BUILD_NAME}.loader.js`

    async function boot() {
      try {
        const response = await fetch(loaderUrl, { method: 'HEAD', cache: 'no-store' })
        if (!response.ok || cancelled) return
        setAvailable(true)
        onStatus?.('3D 模型加载中')
        await loadScript(loaderUrl)
        if (cancelled || !window.createUnityInstance || !canvasRef.current) return
        const instance = await window.createUnityInstance(canvasRef.current, {
          dataUrl: `${AVATAR_ROOT}/Build/${BUILD_NAME}.data`,
          frameworkUrl: `${AVATAR_ROOT}/Build/${BUILD_NAME}.framework.js`,
          codeUrl: `${AVATAR_ROOT}/Build/${BUILD_NAME}.wasm`,
          streamingAssetsUrl: `${AVATAR_ROOT}/StreamingAssets`,
          companyName: 'AI数字人面试',
          productName: 'AI数字人面试官',
          productVersion: '0.1.0',
        }, value => setProgress(Math.round(value * 100)))
        if (cancelled) {
          await instance.Quit()
          return
        }
        unityRef.current = instance
        instance.SendMessage('InterviewerAvatar', 'SetSpeaking', speaking ? 'true' : 'false')
        onStatus?.('3D 数字人在线')
      } catch {
        setAvailable(false)
        onStatus?.('视频数字人在线')
      }
    }

    boot()
    return () => {
      cancelled = true
      const instance = unityRef.current
      unityRef.current = null
      instance?.Quit?.().catch(() => {})
    }
  }, [])

  useEffect(() => {
    unityRef.current?.SendMessage('InterviewerAvatar', 'SetSpeaking', speaking ? 'true' : 'false')
    if (speaking && audioContextRef.current?.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {})
    }
  }, [speaking])

  useEffect(() => {
    if (!available) return undefined
    let cancelled = false
    let lastSent = 0

    async function connectAnalyser() {
      const audio = audioRef.current
      if (!audio?.srcObject) {
        if (!cancelled) window.setTimeout(connectAnalyser, 300)
        return
      }

      try {
        const context = new AudioContext()
        const source = context.createMediaStreamSource(audio.srcObject)
        const analyser = context.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.68
        source.connect(analyser)
        audioContextRef.current = context
        const waveform = new Uint8Array(analyser.frequencyBinCount)

        const update = timestamp => {
          if (cancelled) return
          if (timestamp - lastSent >= 34 && unityRef.current) {
            analyser.getByteTimeDomainData(waveform)
            const open = Math.min(1, averageEnergy(waveform, 0, waveform.length) * 9.5)
            const low = averageEnergy(waveform, 0, 40)
            const high = averageEnergy(waveform, 90, 220)
            const total = Math.max(0.01, low + high)
            const wide = Math.min(1, open * (0.3 + (high / total) * 0.85))
            const round = Math.min(1, open * (0.25 + (low / total) * 0.75))
            unityRef.current.SendMessage(
              'InterviewerAvatar',
              'SetLipSyncFrame',
              `${open.toFixed(3)},${wide.toFixed(3)},${round.toFixed(3)}`,
            )
            lastSent = timestamp
          }
          animationRef.current = requestAnimationFrame(update)
        }
        animationRef.current = requestAnimationFrame(update)
      } catch {
        // TTS 音频仍会正常播放；仅口型分析回退为 Unity 自然待机。
      }
    }

    connectAnalyser()
    return () => {
      cancelled = true
      cancelAnimationFrame(animationRef.current)
      audioContextRef.current?.close().catch(() => {})
      audioContextRef.current = null
    }
  }, [available, audioRef])

  return <>
    <video ref={videoRef} className={available ? 'avatar-video-fallback hidden' : 'avatar-video-fallback'} autoPlay playsInline />
    <audio ref={audioRef} autoPlay />
    {available && <div className="unity-avatar-shell">
      <canvas id="unity-avatar-canvas" ref={canvasRef} />
      {progress < 100 && <div className="unity-avatar-loading">
        <span>正在加载 3D 面试官</span>
        <i><b style={{ width: `${progress}%` }} /></i>
        <small>{progress}%</small>
      </div>}
    </div>}
  </>
}
