"""SSH policy shared by ARM input profiles. Never writes the HID device itself."""
import os
SSH = [os.environ.get('IZ2S_SSH_BINARY') or 'ssh', '-F', os.devnull, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
       '-o', 'ConnectTimeout=4', '-o', 'ServerAliveInterval=3', '-o', 'ServerAliveCountMax=2']
identity = os.environ.get('IZ2S_SSH_IDENTITY') or os.environ.get('IZ15_SSH_IDENTITY')
if identity: SSH += ['-i', identity]
known_hosts = os.environ.get('IZ2S_SSH_KNOWN_HOSTS') or os.environ.get('IZ15_SSH_KNOWN_HOSTS')
if known_hosts:
    if os.name == 'nt': known_hosts = known_hosts.replace('\\', '/')
    # -o values are parsed again by OpenSSH; preserve a path containing spaces.
    SSH += ['-o', 'UserKnownHostsFile="'+known_hosts.replace('\\', '\\\\').replace('"', '\\"')+'"']
host_alias = os.environ.get('IZ2S_SSH_HOST_KEY_ALIAS') or os.environ.get('IZ15_SSH_HOST_KEY_ALIAS')
if host_alias: SSH += ['-o', 'HostKeyAlias='+host_alias]
