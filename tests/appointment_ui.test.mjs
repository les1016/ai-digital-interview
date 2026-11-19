import test from 'node:test'
import assert from 'node:assert/strict'
import { appointmentStage, availableAppointmentSlot } from '../apps/web/src/appointmentPolicy.js'

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
