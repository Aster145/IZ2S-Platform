"""Host adapter for the existing ESP32S3-TEXTKEY/1 TYPE2 and KEY protocol.

Based on the user's type_esp32s3.py adapter and TextKeyboard v1.3 sources.
This file only sends explicit host jobs; it never installs firmware.
"""
import json
import re
import sys
import threading
import time

import serial
from serial.tools import list_ports

IDENTITY = 'ESP32S3-TEXTKEY/1'
KEYS = dict(enter=176, escape=177, backspace=178, tab=179, capslock=193,
            f4=197, f7=200, f8=201, home=210, delete=212, end=213,
            right=215, left=216, down=217, up=218)


class ProtocolError(RuntimeError):
    pass


class Cancelled(ProtocolError):
    pass


def fields(identity):
    if not identity.startswith(IDENTITY + ' '):
        raise ProtocolError('Serial device is not ESP32-S3 TextKeyboard')
    values = dict(item.split('=', 1) for item in identity.split()[1:] if '=' in item)
    try:
        maximum, hold = int(values['MAX']), int(values['KEY_HOLD'])
    except (KeyError, ValueError) as error:
        raise ProtocolError('Firmware is missing MAX/KEY_HOLD capabilities') from error
    if values.get('TYPE2') != '1' or values.get('CAPS_FIX') != '1' or not 1 <= maximum <= 1048576 or not 20 <= hold <= 1000:
        raise ProtocolError('Expected TextKeyboard TYPE2=1, CAPS_FIX=1 and KEY_HOLD>=20')
    return values


def validate_settings(settings):
    port = settings.get('esp32Port', '')
    if not isinstance(port, str) or not re.fullmatch(r'(COM[1-9][0-9]{0,3}|/dev/[A-Za-z0-9_./-]+)', port, re.I):
        raise ValueError('Select the ESP32-S3 UART serial port')
    if str(settings.get('esp32Baud', '115200')) != '115200':
        raise ValueError('TextKeyboard requires 115200 baud')
    gap = int(settings.get('esp32KeyGapMs', 40))
    if not 1 <= gap <= 1000:
        raise ValueError('Key delay must be 1-1000 ms')
    if settings.get('esp32SwapCase', 'no') not in ('yes', 'no'):
        raise ValueError('Choose whether to swap letter case')
    return port, gap


def text_bytes(text, source=False):
    if not isinstance(text, str):
        raise ValueError('Expected ASCII text')
    if source:
        text = text.replace('\r\n', '\n').replace('\r', '\n')
    if any(not (32 <= ord(ch) <= 126 or (source and ch == '\n')) for ch in text):
        raise ValueError('Plan text must be printable ASCII; source may also contain newlines')
    if source and text and not text.endswith('\n'):
        text += '\n'
    return text.encode('ascii')


def validate_plan(plan):
    if not isinstance(plan, dict) or plan.get('action') != 'plan' or not re.fullmatch(r'[a-f0-9-]{36}', plan.get('requestId', '')):
        raise ValueError('Expected an engine-provided input plan')
    steps = plan.get('steps')
    if not isinstance(steps, list) or len(steps) > 4096:
        raise ValueError('Invalid plan steps')
    source_after = plan.get('sourceAfter', len(steps))
    if type(source_after) is not int or not 0 <= source_after <= len(steps):
        raise ValueError('Invalid source insertion point')
    source = None if plan.get('source') is None else text_bytes(plan['source'], source=True)
    if source is not None and len(source) > 131073:
        raise ValueError('Source is too large')
    for step in steps:
        kind = step.get('type')
        if kind == 'line':
            if len(text_bytes(step.get('text'))) > 2048:
                raise ValueError('Plan line is too long')
        elif kind == 'key':
            if step.get('key') not in KEYS:
                raise ValueError('Unsupported plan key')
        elif kind != 'sleep':
            raise ValueError('Unsupported plan step')
        delay = step.get('ms') if kind == 'sleep' else step.get('delayMs', 500)
        if type(delay) is not int or not 0 <= delay <= 120000:
            raise ValueError('Invalid plan delay')
    return source, source_after


def source_chunks(source, maximum):
    chunks, current = [], b''
    for line in source.splitlines(keepends=True):
        if len(line) > maximum:
            raise ValueError('A source line exceeds the firmware payload limit')
        if current and len(current) + len(line) > maximum:
            chunks.append(current)
            current = b''
        current += line
    if current:
        chunks.append(current)
    return chunks


def open_serial(port, assert_lines=False):
    connection = serial.Serial(port=None, baudrate=115200, bytesize=8,
                               parity='N', stopbits=1, timeout=.2, write_timeout=5)
    connection.dtr = assert_lines
    connection.rts = assert_lines
    connection.port = port
    try:
        connection.open()
        time.sleep(1.2)
        connection.reset_input_buffer()
        return connection
    except BaseException:
        connection.close()
        raise


class Sender:
    def __init__(self, connection, cancelled=None, swap_case=False):
        self.serial = connection
        self.cancelled = cancelled or threading.Event()
        self.swap_case = swap_case
        self.pending = b''
        self.phase = 'idle'

    def write(self, data):
        if self.serial.write(data) != len(data):
            raise ProtocolError('Incomplete serial write; text was not resent')

    def line(self, deadline):
        while time.monotonic() < deadline:
            if b'\n' in self.pending:
                raw, self.pending = self.pending.split(b'\n', 1)
                return raw.decode('ascii', 'replace').strip()
            self.serial.timeout = min(.2, max(.001, deadline - time.monotonic()))
            self.pending += self.serial.readline()
            if len(self.pending) > 4096:
                raise ProtocolError('Serial response is too long')
        raise ProtocolError('Serial response timed out; no text was retried')

    def wait(self, expected, timeout=5, cancellable=False):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if cancellable and self.cancelled.is_set():
                self.stop_typing()
                raise Cancelled('Input job cancelled')
            # Short read windows let cancellation interrupt a long TYPE2 job.
            try:
                reply = self.line(min(deadline, time.monotonic() + .25))
            except ProtocolError as error:
                if 'timed out' in str(error):
                    continue
                raise
            if reply == expected or (expected == 'identity' and reply.startswith(IDENTITY + ' ')):
                return reply
            if reply.startswith('ERR') or reply == 'CANCELLED':
                self.phase = 'idle'
                raise ProtocolError('Firmware reported: ' + reply)
            if reply in ['READY', 'QUEUED', 'DONE'] or reply.startswith(IDENTITY):
                raise ProtocolError('Expected ' + expected + ', received ' + reply)
        raise ProtocolError('Timed out waiting for ' + expected + '; no text was retried')

    def check_cancelled(self):
        if self.cancelled.is_set():
            raise Cancelled('Input job cancelled')

    def pause(self, milliseconds):
        if self.cancelled.wait(milliseconds / 1000):
            raise Cancelled('Input job cancelled')

    def ping(self):
        self.write(b'PING\n')
        identity = self.wait('identity')
        return identity, fields(identity)

    def stop_typing(self):
        if self.phase == 'idle':
            return
        if self.phase == 'receiving':
            # TYPE2 is waiting for a byte count; CAN would become payload data.
            # No payload was supplied, so its 5 s receive timeout sends no keys.
            deadline = time.monotonic() + 7
            while time.monotonic() < deadline:
                reply = self.line(deadline)
                if reply in ['ERR TIMEOUT', 'ERR ASCII_ONLY', 'CANCELLED']:
                    self.phase = 'idle'
                    return
            raise ProtocolError('Input cancellation is unconfirmed')
        self.write(b'\x18')
        deadline = time.monotonic() + 7
        while time.monotonic() < deadline:
            reply = self.line(deadline)
            if reply in ['CANCELLED', 'DONE', 'ERR HID']:
                self.phase = 'idle'
                return
            if reply.startswith('ERR'):
                raise ProtocolError('Input cancellation is unconfirmed: ' + reply)
        raise ProtocolError('Input cancellation is unconfirmed')

    def payload(self, value, capabilities, gap, no_indent=False):
        self.check_cancelled()
        if not value:
            return
        maximum, hold = int(capabilities['MAX']), int(capabilities['KEY_HOLD'])
        if len(value) > maximum or any(ch != 10 and not 32 <= ch <= 126 for ch in value):
            raise ValueError('Payload exceeds firmware ASCII or length limits')
        # Explicit screen-verified correction, shared by source and command text.
        # ASCII swapcase leaves byte counts, digits, punctuation and keys intact.
        if self.swap_case:
            value = value.swapcase()
        self.phase = 'receiving'
        self.write(('TYPE2 0 %d %d 150 %d\n' % (len(value), gap, int(no_indent))).encode('ascii'))
        self.wait('READY')
        if self.cancelled.is_set():
            self.stop_typing()
            raise Cancelled('Input job cancelled before payload')
        self.write(value)
        self.phase = 'typing'
        self.wait('QUEUED', timeout=10)
        newlines = value.count(b'\n')
        line_ms = hold + max(gap, 150) + (90 + 2 * hold + max(gap, 30) if no_indent else 0)
        seconds = ((len(value) - newlines) * (hold + gap) + newlines * line_ms) / 1000
        self.wait('DONE', timeout=max(15, seconds * 1.25 + 10), cancellable=True)
        self.phase = 'idle'

    def key(self, name):
        self.check_cancelled()
        self.phase = 'key'
        self.write(('KEY %d 1\n' % KEYS[name]).encode('ascii'))
        self.wait('DONE')
        self.phase = 'idle'


def perform(sender, plan, capabilities, gap, report):
    source, insertion = validate_plan(plan)
    maximum = int(capabilities['MAX'])
    chunks = source_chunks(source, maximum) if source is not None else []
    # Check every line before the first key, even if its step occurs later.
    for step in plan['steps']:
        if step['type'] == 'line' and len(text_bytes(step['text'])) > maximum:
            raise ValueError('Plan line exceeds the firmware payload limit')
    for index in range(len(plan['steps']) + 1):
        sender.check_cancelled()
        if source is not None and index == insertion:
            for chunk_index, chunk in enumerate(chunks):
                report('Typing bootstrap source', chunk=chunk_index + 1, total=len(chunks), bytes=len(chunk))
                sender.payload(chunk, capabilities, gap, no_indent=True)
        if index == len(plan['steps']):
            break
        step = plan['steps'][index]
        if step['type'] == 'line':
            report('Typing generated connection command' if step['text'].startswith('V=START(') else 'Typing plan line', step=index + 1, total=len(plan['steps']))
            sender.payload(text_bytes(step['text']), capabilities, gap)
            sender.key('escape')
            sender.pause(500)
            sender.key('enter')
            sender.pause(step.get('delayMs', 500))
        elif step['type'] == 'key':
            sender.key(step['key'])
            sender.pause(step.get('delayMs', 500))
        else:
            sender.pause(step['ms'])


def emit(value):
    print(json.dumps(value), flush=True)


def main(request):
    action = request.get('action')
    if action == 'ports':
        emit([dict(port=row.device, description=row.description, vid=row.vid, pid=row.pid,
                   serialNumber=row.serial_number) for row in list_ports.comports()])
        return 0
    settings = request.get('settings', {})
    port, gap = validate_settings(settings)
    if action == 'plan':
        validate_plan(request.get('plan'))
        if settings.get('esp32UsbConfirmed') != 'yes':
            raise ValueError('Confirm the USB/OTG data cable is connected to Switch before typing')
    elif action != 'inspect':
        raise ValueError('Unknown serial adapter operation')
    cancelled = threading.Event()
    if action == 'plan':
        def controls():
            for line in sys.stdin:
                try:
                    if json.loads(line).get('action') == 'cancel':
                        cancelled.set()
                except (ValueError, AttributeError):
                    cancelled.set()
            cancelled.set()  # Parent exit also requests cancellation.
        threading.Thread(target=controls, daemon=True).start()
    with open_serial(port, assert_lines=False) as connection:
        sender = Sender(connection, cancelled, swap_case=settings.get('esp32SwapCase', 'no') == 'yes')
        try:
            sender.check_cancelled()
            identity, capabilities = sender.ping()
            if action == 'inspect':
                confirmed = settings.get('esp32UsbConfirmed') == 'yes'
                emit(dict(reachable=True, moduleReady=True, keyboard=confirmed, keyboardBusy=False,
                          installed=True, setupRequired=not confirmed, service='esp32s3-serial',
                          identity=identity, ledSeen=capabilities.get('LED_SEEN') == '1',
                          usbReadySource='user-confirmed' if confirmed else 'unconfirmed',
                          detail='TextKeyboard protocol verified on ' + port,
                          usbDetail='USB/OTG connection confirmed by you; firmware does not report live HID readiness' if confirmed else 'Confirm the ESP32-S3 USB/OTG data port is connected to Switch'))
            else:
                perform(sender, request['plan'], capabilities, gap,
                        lambda detail, **values: emit(dict(detail=detail, fields=values)))
                emit(dict(done=dict(ok=True, completion='firmware-DONE')))
            return 0
        except BaseException as error:
            cancellation_confirmed = False
            try:
                sender.stop_typing()
                cancellation_confirmed = isinstance(error, Cancelled)
            except BaseException as stop_error:
                error = ProtocolError(str(error) + '; ' + str(stop_error))
            if action == 'plan':
                emit(dict(done=dict(ok=False, stopped=cancellation_confirmed, error=str(error))))
                return 1
            raise


if __name__ == '__main__':
    try:
        raise SystemExit(main(json.loads(sys.stdin.readline())))
    except (ValueError, OSError, serial.SerialException, ProtocolError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
