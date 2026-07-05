"""Transcribe a Telegram voice message (.oga/.ogg) to text.
Usage: python transcribe_voice.py <input.oga> [language=ru-RU]
Requires: ffmpeg at D:\\YandexDisk\\ScriptsDrift\\webmPreview\\ffmpeg.exe
          SpeechRecognition (pip: speech_recognition)
"""
import sys, os, io, tempfile, subprocess
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

FFMPEG = r'D:\YandexDisk\ScriptsDrift\webmPreview\ffmpeg.exe'

if not os.path.exists(FFMPEG):
    print(f'ERROR: ffmpeg not found at {FFMPEG}')
    sys.exit(1)

input_file = sys.argv[1]
language = sys.argv[2] if len(sys.argv) > 2 else 'ru-RU'

if not os.path.exists(input_file):
    print(f'ERROR: file not found: {input_file}')
    sys.exit(1)

# Convert OGA/OGG to WAV 16kHz mono
with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
    wav_path = tmp.name

try:
    result = subprocess.run(
        [FFMPEG, '-y', '-i', input_file, '-ar', '16000', '-ac', '1', wav_path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f'ERROR: ffmpeg failed: {result.stderr[:200]}')
        sys.exit(1)

    import speech_recognition as sr
    recognizer = sr.Recognizer()
    with sr.AudioFile(wav_path) as source:
        audio = recognizer.record(source)
    text = recognizer.recognize_google(audio, language=language)
    print(text)
finally:
    try:
        os.unlink(wav_path)
    except Exception:
        pass
    # Delete original voice file after transcription to avoid disk clutter
    try:
        os.unlink(input_file)
    except Exception:
        pass
