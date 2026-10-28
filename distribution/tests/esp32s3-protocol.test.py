"""Offline serial protocol regression: no real COM ports are opened."""
import contextlib
import importlib.util
import io
from pathlib import Path
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('esp32_worker', Path(__file__).parents[2] / 'hardware/transports/esp32s3-serial/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
IDENTITY = 'ESP32S3-TEXTKEY/1 FW=1.3 TYPE2=1 KEY_HOLD=20 ASCII MAX=8192 INPUT=USB+UART0 CAPS_FIX=1 CAPS=0 LED_SEEN=1'
CAPS = worker.fields(IDENTITY)
SETTINGS = dict(esp32Port='COM_TEST', esp32Baud='115200', esp32KeyGapMs='40', esp32UsbConfirmed='yes')
PLAN = dict(action='plan', requestId='12345678-1234-1234-1234-123456789abc', steps=[], source=None, sourceAfter=0)


class FakeSerial:
    def __init__(self, replies=(), after_read=None):
        self.replies = list(replies)
        self.writes = []
        self.after_read = after_read

    def write(self, value):
        self.writes.append(value)
        return len(value)

    def readline(self):
        if not self.replies:
            raise AssertionError('Unexpected serial read')
        reply = self.replies.pop(0)
        if self.after_read:
            self.after_read(reply)
        return reply

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class ProtocolTests(unittest.TestCase):
    def test_ping_handles_fragmented_banner_and_never_sends_keys(self):
        serial = FakeSerial([b'ESP-ROM startup\n', IDENTITY[:20].encode(), IDENTITY[20:].encode() + b'\n'])
        identity, caps = worker.Sender(serial).ping()
        self.assertEqual(identity, IDENTITY)
        self.assertEqual(caps['TYPE2'], '1')
        self.assertEqual(serial.writes, [b'PING\n'])

    def test_inspect_does_not_turn_historical_led_into_usb_readiness(self):
        serial = FakeSerial([(IDENTITY + '\n').encode()])
        with mock.patch.object(worker, 'open_serial', return_value=serial) as opened, contextlib.redirect_stdout(io.StringIO()) as stdout:
            worker.main(dict(action='inspect', settings={**SETTINGS, 'esp32Port': 'COM15', 'esp32UsbConfirmed': 'no'}))
        import json
        status = json.loads(stdout.getvalue())
        self.assertTrue(status['reachable'])
        self.assertTrue(status['ledSeen'])
        self.assertFalse(status['keyboard'])
        self.assertEqual(status['usbReadySource'], 'unconfirmed')
        opened.assert_called_once_with('COM15', assert_lines=False)
        self.assertEqual(serial.writes, [b'PING\n'])

    def test_typing_does_not_assert_dtr_or_rts(self):
        serial = FakeSerial([(IDENTITY + '\n').encode()])
        with mock.patch.object(worker, 'open_serial', return_value=serial) as opened, \
                mock.patch.object(worker, 'perform') as perform, \
                mock.patch.object(worker.threading, 'Thread') as controls, \
                contextlib.redirect_stdout(io.StringIO()):
            worker.main(dict(action='plan', settings={**SETTINGS, 'esp32Port': 'COM15'}, plan=PLAN))
        opened.assert_called_once_with('COM15', assert_lines=False)
        controls.return_value.start.assert_called_once()
        perform.assert_called_once()
        self.assertEqual(serial.writes, [b'PING\n'])

    def test_serial_open_sets_control_lines_low_before_open(self):
        connection = mock.Mock()
        def opening():
            self.assertIs(connection.dtr, False)
            self.assertIs(connection.rts, False)
        connection.open.side_effect = opening
        with mock.patch.object(worker.serial, 'Serial', return_value=connection), \
                mock.patch.object(worker.time, 'sleep'):
            self.assertIs(worker.open_serial('COM15'), connection)
        connection.open.assert_called_once()

    def test_type2_requires_ready_then_queued_then_done(self):
        serial = FakeSerial([b'READY\n', b'QUEUED\n', b'DONE\n'])
        worker.Sender(serial).payload(b'PRINT 1\n', CAPS, 40, no_indent=True)
        self.assertEqual(serial.writes, [b'TYPE2 0 8 40 150 1\n', b'PRINT 1\n'])
        bad = FakeSerial([b'DONE\n'])
        with self.assertRaisesRegex(worker.ProtocolError, 'Expected READY'):
            worker.Sender(bad).payload(b'X', CAPS, 40)
        self.assertEqual(len(bad.writes), 1)

    def test_hid_failure_is_not_success_and_text_is_never_retried(self):
        serial = FakeSerial([b'READY\n', b'QUEUED\n', b'ERR HID\n'])
        with self.assertRaisesRegex(worker.ProtocolError, 'ERR HID'):
            worker.Sender(serial).payload(b'X', CAPS, 40)
        self.assertEqual(serial.writes, [b'TYPE2 0 1 40 150 0\n', b'X'])

    def test_case_correction_covers_source_and_commands_without_changing_keys_or_symbols(self):
        plan = {**PLAN, 'source': 'AbZz09!"\n', 'sourceAfter': 1,
                'steps': [dict(type='key', key='f4', delayMs=0),
                          dict(type='line', text='LOAD "TXT:NS2I"', delayMs=0)]}
        for setting in (None, 'no', 'yes'):
            with self.subTest(setting=setting):
                serial = FakeSerial([(IDENTITY + '\n').encode(), b'DONE\n',
                                     b'READY\n', b'QUEUED\n', b'DONE\n',
                                     b'READY\n', b'QUEUED\n', b'DONE\n', b'DONE\n', b'DONE\n'])
                settings = {**SETTINGS, 'esp32Port': 'COM15'}
                if setting is not None:
                    settings['esp32SwapCase'] = setting
                with mock.patch.object(worker, 'open_serial', return_value=serial), \
                        mock.patch.object(worker.threading, 'Thread'), \
                        mock.patch.object(worker.Sender, 'pause'), \
                        contextlib.redirect_stdout(io.StringIO()):
                    result = worker.main(dict(action='plan', settings=settings, plan=plan))
                self.assertEqual(result, 0)
                self.assertEqual(serial.writes, [b'PING\n', b'KEY 197 1\n',
                    b'TYPE2 0 9 40 150 1\n', b'aBzZ09!"\n' if setting == 'yes' else b'AbZz09!"\n',
                    b'TYPE2 0 15 40 150 0\n', b'load "txt:ns2i"' if setting == 'yes' else b'LOAD "TXT:NS2I"',
                    b'KEY 177 1\n', b'KEY 176 1\n'])

    def test_case_correction_keeps_ascii_and_length_validation_before_writing(self):
        for payload, capabilities in ((b'\x80', CAPS), (b'AB', {**CAPS, 'MAX': '1'})):
            with self.subTest(payload=payload):
                serial = FakeSerial()
                with self.assertRaisesRegex(ValueError, 'ASCII or length limits'):
                    worker.Sender(serial, swap_case=True).payload(payload, capabilities, 40)
                self.assertEqual(serial.writes, [])

    def test_invalid_case_correction_setting_is_rejected_before_opening_port(self):
        with mock.patch.object(worker, 'open_serial') as opened:
            with self.assertRaisesRegex(ValueError, 'swap letter case'):
                worker.main(dict(action='plan', settings={**SETTINGS, 'esp32Port': 'COM15',
                                                         'esp32SwapCase': 'invalid'}, plan=PLAN))
            opened.assert_not_called()

    def test_partial_serial_write_is_not_retried(self):
        serial = FakeSerial()
        serial.write = mock.Mock(return_value=1)
        with self.assertRaisesRegex(worker.ProtocolError, 'not resent'):
            worker.Sender(serial).payload(b'X', CAPS, 40)
        self.assertEqual(serial.write.call_count, 1)

    def test_cancel_during_typing_requires_firmware_ack(self):
        event = threading.Event()
        serial = FakeSerial([b'READY\n', b'QUEUED\n', b'CANCELLED\n'],
                            after_read=lambda value: event.set() if value == b'QUEUED\n' else None)
        sender = worker.Sender(serial, event)
        with self.assertRaises(worker.Cancelled):
            sender.payload(b'PRINT 1', CAPS, 40)
        self.assertEqual(serial.writes[-1], b'\x18')
        self.assertEqual(sender.phase, 'idle')

    def test_cancel_before_payload_waits_receive_timeout_and_sends_no_text(self):
        event = threading.Event()
        serial = FakeSerial([b'READY\n', b'ERR TIMEOUT\n'],
                            after_read=lambda value: event.set() if value == b'READY\n' else None)
        sender = worker.Sender(serial, event)
        with self.assertRaises(worker.Cancelled):
            sender.payload(b'X', CAPS, 40)
        self.assertEqual(serial.writes, [b'TYPE2 0 1 40 150 0\n'])
        self.assertEqual(sender.phase, 'idle')

    def test_entire_plan_is_validated_before_opening_port(self):
        bad = {**PLAN, 'steps': [dict(type='line', text='PRINT 1', delayMs=0), dict(type='line', text='bad\x18', delayMs=0)]}
        with mock.patch.object(worker, 'open_serial') as opened:
            with self.assertRaises(ValueError):
                worker.main(dict(action='plan', settings={**SETTINGS, 'esp32Port': 'COM15'}, plan=bad))
            opened.assert_not_called()

    def test_usb_confirmation_is_required_before_opening_for_typing(self):
        with mock.patch.object(worker, 'open_serial') as opened:
            with self.assertRaisesRegex(ValueError, 'Confirm the USB'):
                worker.main(dict(action='plan', settings={**SETTINGS, 'esp32Port': 'COM15', 'esp32UsbConfirmed': 'no'}, plan=PLAN))
            opened.assert_not_called()

    def test_source_chunks_preserve_lines_and_respect_firmware_limit(self):
        source = worker.text_bytes('  PRINT 1\r\nEND\n' * 700, source=True)
        chunks = worker.source_chunks(source, 8192)
        self.assertEqual(b''.join(chunks), source)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= 8192 and chunk.endswith(b'\n') for chunk in chunks))
        with self.assertRaises(ValueError):
            worker.source_chunks(b'A' * 8192 + b'\n', 8192)

    def test_engine_plan_line_key_sleep_and_source_insertion(self):
        sender = mock.Mock()
        plan = {**PLAN, 'source': 'PRINT 1\n', 'sourceAfter': 1,
                'steps': [dict(type='key', key='f4', delayMs=0), dict(type='line', text='RUN', delayMs=0), dict(type='sleep', ms=0)]}
        worker.perform(sender, plan, CAPS, 40, mock.Mock())
        self.assertEqual(sender.key.call_args_list, [mock.call('f4'), mock.call('escape'), mock.call('enter')])
        self.assertEqual(sender.payload.call_args_list, [mock.call(b'PRINT 1\n', CAPS, 40, no_indent=True), mock.call(b'RUN', CAPS, 40)])

    def test_key_uses_existing_firmware_key_command(self):
        serial = FakeSerial([b'DONE\n', b'DONE\n'])
        sender = worker.Sender(serial)
        sender.key('f4')
        sender.key('enter')
        self.assertEqual(serial.writes, [b'KEY 197 1\n', b'KEY 176 1\n'])


if __name__ == '__main__':
    unittest.main()
