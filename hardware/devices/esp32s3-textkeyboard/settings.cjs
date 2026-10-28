function validate(value) {
  const requirements = [];
  value.esp32Port = String(value.esp32Port || '').trim();
  if (value.esp32Port && !/^(COM[1-9][0-9]{0,3}|\/dev\/[A-Za-z0-9_.\/-]+)$/i.test(value.esp32Port))
    throw Error('Choose a COM port or a local /dev serial device');
  if (/^COM/i.test(value.esp32Port)) value.esp32Port = value.esp32Port.toUpperCase();
  if (!value.esp32Port) requirements.push('Select the ESP32-S3 UART serial port.');
  if (String(value.esp32Baud) !== '115200') throw Error('TextKeyboard requires 115200 baud');
  const gap = Number(value.esp32KeyGapMs);
  if (!Number.isInteger(gap) || gap < 1 || gap > 1000) throw Error('Key delay must be 1-1000 ms');
  value.esp32SwapCase ??= 'no';
  if (!['yes', 'no'].includes(value.esp32SwapCase)) throw Error('Choose whether to swap letter case');
  if (!['yes', 'no'].includes(value.esp32UsbConfirmed)) throw Error('Confirm the USB/OTG connection setting');
  return requirements;
}
module.exports = { validate };
