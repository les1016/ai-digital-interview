import test from 'node:test'
import assert from 'node:assert/strict'
import { appointmentStage, availableAppointmentSlot, appointmentTimeZoneLabel, nextAvailableNightSlot } from '../apps/web/src/appointmentPolicy.js'

const now = value => Date.parse(`2031-02-01T${value}Z`)
const booked = {
  status: 'booked',
  start_at: '2031-02-01T10:00:00Z',
  check_in_by: '2031-02-01T10:05:00Z',
}

test('ordinary check-in permits exactly [slot start, cutoff)', () => {
  assert.equal(appointmentStage(booked, now('09:59:59')), 'upcoming')
  assert.equal(appointmentStage(booked, now('10:00:00')), 'sign-in')
  assert.equal(appointmentStage(booked, now('10:04:59')), 'sign-in')
  assert.equal(appointmentStage(booked, now('10:05:00')), 'elapsed')
})

test('checked-in session ends at the absolute deadline, not 20 minutes after page load', () => {
  const checkedIn = { ...booked, status: 'checked_in', ends_at: '2031-02-01T10:22:00Z' }
  assert.equal(appointmentStage(checkedIn, now('10:21:59')), 'checked-in')
  assert.equal(appointmentStage(checkedIn, now('10:22:00')), 'elapsed')
  assert.equal(appointmentStage({ ...checkedIn, ends_at: null }, now('10:21:59')), 'elapsed')
})

test('available inventory can be reserved through its server-provided cutoff', () => {
  const available = { ...booked, available: true }
  assert.equal(availableAppointmentSlot(available, now('09:59:59')), true)
  assert.equal(availableAppointmentSlot(available, now('10:00:00')), true)
  assert.equal(availableAppointmentSlot(available, now('10:05:00')), false)
  const refill = { ...available, refill: true, check_in_by: '2031-02-01T10:10:00Z' }
  assert.equal(availableAppointmentSlot(refill, now('10:05:00')), true)
  assert.equal(availableAppointmentSlot({ ...refill, available: false }, now('10:05:00')), false)
  assert.equal(availableAppointmentSlot(refill, now('10:10:00')), false)
})

test('the Shanghai calendar is labelled in Beijing time without changing custom zones', () => {
  assert.equal(appointmentTimeZoneLabel('Asia/Shanghai'), '北京时间（UTC+8）')
  assert.equal(appointmentTimeZoneLabel('Europe/London'), 'Europe/London')
})

test('night shortcut skips elapsed and unavailable slots, then finds the next night across midnight', () => {
  const slots = [
    { overnight: true, available: true, check_in_by: '2031-02-01T15:50:00Z' },
    { overnight: false, available: true, check_in_by: '2031-02-01T16:00:00Z' },
    { overnight: true, available: false, check_in_by: '2031-02-01T16:05:00Z' },
    { overnight: true, available: true, check_in_by: '2031-02-01T16:35:00Z' },
  ]
  assert.equal(nextAvailableNightSlot(slots, now('15:53:00')), slots[3])
  assert.equal(nextAvailableNightSlot(slots, now('16:35:00')), undefined)
  assert.equal(nextAvailableNightSlot(null, now('15:53:00')), undefined)
})
