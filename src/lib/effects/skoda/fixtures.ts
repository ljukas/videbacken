// Shapes seen live on the owner's car (2026-10-02), with every value made up:
// the VIN is the Škoda docs' sample, coordinates are central Stockholm.
export const TEST_VIN = 'TMBJB9NY5RF999999'
export const TEST_KEY = 'test-key'
export const EXPIRES_AT = '2027-01-15T12:00:00.5Z'

export const chargingAtHome = {
  vehicle: {
    vin: TEST_VIN,
    charging: {
      isVehicleInSavedLocation: true,
      carCapturedTimestamp: '2026-05-04T08:57:51Z',
      status: {
        battery: { remainingCruisingRangeInMeters: 300000, stateOfChargeInPercent: 55 },
        chargePowerInKw: 3.5,
        chargeType: 'AC',
        plugConnectionState: 'CONNECTED',
        plugLockState: 'LOCKED',
        state: 'CHARGING',
      },
    },
    odometer: { mileageInKm: 12345, carCapturedTimestamp: '2026-05-04T08:55:01.847Z' },
    parkingPosition: {
      state: 'PARKED',
      formattedAddress: 'redacted',
      gpsCoordinates: { latitude: 59.3293, longitude: 18.0686 },
    },
  },
  errors: [],
}

// Unplugged: `chargeType` is omitted entirely; the car is moving (no position).
export const unplugged = {
  vehicle: {
    vin: TEST_VIN,
    charging: {
      carCapturedTimestamp: '2026-05-04T08:40:10Z',
      status: {
        battery: { stateOfChargeInPercent: 55 },
        chargePowerInKw: 0,
        plugConnectionState: 'DISCONNECTED',
        plugLockState: 'UNLOCKED',
        state: 'CONNECT_CABLE',
      },
    },
    odometer: { mileageInKm: 12345, carCapturedTimestamp: '2026-05-04T08:41:24.258Z' },
    parkingPosition: { state: 'IN_MOTION' },
  },
}

// A partial 200: the charging part could not be retrieved.
export const chargingUnavailable = {
  vehicle: { vin: TEST_VIN, odometer: { mileageInKm: 12349 } },
  errors: [{ type: 'CHARGING_UNAVAILABLE', description: 'not available' }],
}
