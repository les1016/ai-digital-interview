import { useEffect, useRef } from 'react'

export default function ParticleField() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    const context = canvas.getContext('2d')
    if (!context) return undefined

    let animationFrame = 0
    let width = 0
    let height = 0
    let particles = []
    const pointer = { x: -9999, y: -9999 }

    const reset = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.offsetWidth
      height = canvas.offsetHeight
      canvas.width = Math.max(1, Math.floor(width * ratio))
      canvas.height = Math.max(1, Math.floor(height * ratio))
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      const count = Math.min(92, Math.max(42, Math.floor(width * height / 18000)))
      particles = Array.from({ length: count }, (_, index) => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.24,
        vy: (Math.random() - 0.5) * 0.24,
        radius: index % 8 === 0 ? 1.7 : 1.1,
        pulse: Math.random() * Math.PI * 2,
      }))
    }

    const draw = () => {
      context.clearRect(0, 0, width, height)
      context.fillStyle = 'rgba(31, 101, 90, 0.035)'
      for (let x = 0; x < width; x += 56) context.fillRect(x, 0, 1, height)
      for (let y = 0; y < height; y += 56) context.fillRect(0, y, width, 1)

      for (const particle of particles) {
        if (!reducedMotion) {
          const dx = particle.x - pointer.x
          const dy = particle.y - pointer.y
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance < 115) {
            const force = (115 - distance) / 115
            particle.vx += (dx / Math.max(distance, 1)) * force * 0.012
            particle.vy += (dy / Math.max(distance, 1)) * force * 0.012
          }
          particle.x += particle.vx
          particle.y += particle.vy
          particle.vx *= 0.992
          particle.vy *= 0.992
          particle.pulse += 0.012
          if (particle.x < -20) particle.x = width + 20
          if (particle.x > width + 20) particle.x = -20
          if (particle.y < -20) particle.y = height + 20
          if (particle.y > height + 20) particle.y = -20
        }
      }

      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const left = particles[i]
          const right = particles[j]
          const dx = left.x - right.x
          const dy = left.y - right.y
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance < 118) {
            context.strokeStyle = `rgba(31, 101, 90, ${0.12 * (1 - distance / 118)})`
            context.lineWidth = 1
            context.beginPath()
            context.moveTo(left.x, left.y)
            context.lineTo(right.x, right.y)
            context.stroke()
          }
        }
      }

      for (const particle of particles) {
        const alpha = 0.28 + Math.sin(particle.pulse) * 0.12
        context.fillStyle = `rgba(199, 101, 72, ${alpha})`
        context.beginPath()
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2)
        context.fill()
      }

      animationFrame = window.requestAnimationFrame(draw)
    }

    const handlePointer = event => {
      pointer.x = event.clientX
      pointer.y = event.clientY
    }
    const clearPointer = () => {
      pointer.x = -9999
      pointer.y = -9999
    }

    reset()
    draw()
    window.addEventListener('resize', reset)
    window.addEventListener('pointermove', handlePointer)
    window.addEventListener('pointerleave', clearPointer)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', reset)
      window.removeEventListener('pointermove', handlePointer)
      window.removeEventListener('pointerleave', clearPointer)
    }
  }, [])

  return <canvas className="particle-field" ref={canvasRef} aria-hidden="true" />
}
