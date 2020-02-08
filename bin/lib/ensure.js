//////////////////////////////////////////////////////////////////////
//
// Ensure: provides functions that ensure that certain
// ======= expected conditions exist in the runtime environment.
//
//////////////////////////////////////////////////////////////////////

const childProcess = require('child_process')
const os = require('os')
const path = require('path')

const Site = require('../../index')
const runtime = require('./runtime')
const getStatus = require('./status')
const clr = require('../../lib/clr')

class Ensure {

  // Does the passed command exist? Returns: bool.
  // Note: on Windows this will always fail because which does not exist.
  // ===== This currently does not appear to have any side-effects but it’s
  //       worth considering whether we should add special handling for that
  //       platform here.
  commandExists (command) {
    try {
      childProcess.execFileSync('which', [command], {env: process.env})
      return true
    } catch (error) {
      return false
    }
  }


  // Ensure we have root privileges and exit if we don’t.
  root () {
    os.platform() === 'win32' ? this.rootOnWindows() : this.rootOnLinuxesque()
  }

  rootOnWindows () {
    const isAdministrator = (childProcess.execSync('powershell.exe -Command ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)')).toString().trim() === 'True'

    if (!isAdministrator) {
      let commonArguments = process.argv.slice(2).map(_ => `"${_}"`).join(', ')
      let binaryName
      let theArguments
      try {
        if (runtime.isNode) {
          binaryName = 'node.exe'
          theArguments = `"${path.join(__dirname, '..', 'site.js')}", ${commonArguments}`
        } else {
          binaryName = 'site.exe'
          theArguments = commonArguments
        }
        const command = `powershell.exe -Command Start-Process "${binaryName}" -ArgumentList ${theArguments} -Verb RunAs`
        const options = {env: process.env, stdio: 'inherit'}
        childProcess.execSync(command, options)
      } catch (error) {
        process.exit(1)
      }
      process.exit(0)
    }
  }


  rootOnLinuxesque () {
    if (process.getuid() !== 0) {
      // Requires root but wasn’t run with sudo. Automatically restart using sudo.
      const options = {env: process.env, stdio: 'inherit'}
      try {
        if (runtime.isNode) {
          childProcess.execSync(`sudo node ${path.join(__dirname, '..', 'site.js')} ${process.argv.slice(2).join(' ')}`, options)
        } else {
          childProcess.execSync(`sudo site ${process.argv.slice(2).join(' ')}`, options)
        }
      } catch (error) {
        process.exit(1)
      }
      process.exit(0)
    }
  }


  // Ensure systemctl exists.
  systemctl () {
    if (!this.commandExists('systemctl')) {
      console.error('\n 👿 Sorry, daemons are only supported on Linux systems with systemd (systemctl required).\n')
      process.exit(1)
    }
  }


  // Ensure journalctl exists.
  journalctl () {
    if (!this.commandExists('journalctl')) {
      console.error('\n 👿 Sorry, daemons are only supported on Linux systems with systemd (journalctl required).\n')
      process.exit(1)
    }
  }

  // Ensures that the server daemon is not currently active.
  serverDaemonNotActive () {
    // Ensure systemctl exists as it is required for getStatus().
    // We cannot check in the function itself as it would create
    // a circular dependency.
    this.systemctl()
    const { isActive } = getStatus()

    if (isActive) {
      console.error(`\n 👿 Site.js Daemon is already running.\n\n    ${clr('Please stop it first with the command:', 'yellow')} site ${clr('disable', 'green')}\n`)
      process.exit(1)
    }
  }

  // If we’re on Linux and the requested port is < 1024 ensure that we can bind to it.
  // (As of macOS Mojave, privileged ports are only an issue on Linux. Good riddance too,
  // as these so-called privileged ports are a relic from the days of mainframes and they
  // actually have a negative impact on security today:
  // https://www.staldal.nu/tech/2007/10/31/why-can-only-root-listen-to-ports-below-1024/
  //
  // Note: this might cause issues if https-server is used as a library as it assumes that the
  // ===== current app is in index.js and that it can be forked. This might be an issue if a
  //       process manager is already being used, etc. Worth keeping an eye on and possibly
  //       making this method an optional part of server startup.
  weCanBindToPort (port, callback) {
    if (port < 1024 && os.platform() === 'linux') {
      const options = {env: process.env}
      try {
        childProcess.execSync(`setcap -v 'cap_net_bind_service=+ep' $(which ${process.title})`, options)
        callback()
      } catch (error) {
        try {
          // Allow Node.js to bind to ports < 1024.
          childProcess.execSync(`sudo setcap 'cap_net_bind_service=+ep' $(which ${process.title})`, options)

          Site.logAppNameAndVersion()

          console.log('   😇    [Site.js] First run on Linux: got privileges to bind to ports < 1024.')

          // Fork a new instance of the server so that it is launched with the privileged Node.js.
          const newArgs = process.argv.slice(2)
          newArgs.push('--dont-log-app-name-and-version')

          const luke = childProcess.fork(path.resolve(path.join(__dirname, '..', 'site.js')), newArgs, {env: process.env})

          // Let the child process know it’s a child process.
          luke.send({IAmYourFather: process.pid})

          function exitMainProcess () {
            // Exit main process in response to child process event.
            process.exit()
          }
          luke.on('exit', exitMainProcess)
          luke.on('disconnect', exitMainProcess)
          luke.on('close', exitMainProcess)
          luke.on('error', exitMainProcess)
        } catch (error) {
          console.log(`\n Error: could not get privileges for Node.js to bind to port ${port}.`, error)
          process.exit(1)
        }
      }
    } else {
      // This is only relevant for Linux, which is the last major platform to
      // carry forward the archaic security theatre of privileged ports. On other
      // Linux-like platforms (notably, macOS), just call the callback.
      callback()
    }
  }


  // If the sync option is specified, ensure that Rsync exists on the system.
  // (This will install it automatically if a supported package manager exists.)
  rsyncExists() {
    if (this.commandExists('rsync')) return // Already installed

    if (os.platform() === 'darwin') {
      console.log('\n ⚠️  [Site.js] macOS: rsync should be installed default but isn’t. Please fix this before trying again.\n')
      process.exit(1)
    }

    console.log(' 🌠 [Site.js] Installing Rsync dependency…')
    let options = {env: process.env}
    try {
      if (this.commandExists('apt')) {
        options.env.DEBIAN_FRONTEND = 'noninteractive'
        childProcess.execSync('sudo apt-get install -y -q rsync', options)
        console.log(' 🎉 [Site.js] Rsync installed using apt.\n')
      } else if (this.commandExists('yum')) {
        // Untested: if you test this, please let me know https://github.com/indie-mirror/https-server/issues
        console.log('\n 🤪  [Site.js] Attempting to install required dependency using yum. This is currently untested. If it works (or blows up) for you, I’d appreciate it if you could open an issue at https://github.com/indie-mirror/https-server/issues and let me know. Thanks! – Aral\n')
        childProcess.execSync('sudo yum install rsync', options)
        console.log(' 🎉 [Site.js] Rsync installed using yum.')
      } else if (this.commandExists('pacman')) {
        childProcess.execSync('sudo pacman -S rsync', options)
        console.log(' 🎉 [Site.js] Rsync installed using pacman.')
      } else {
      // No supported package managers installed. Warn the person.
      console.log('\n ⚠️  [Site.js] Linux: No supported package manager found for installing Rsync on Linux (tried apt, yum, and pacman). Please install Rsync manually and run Site.js again.\n')
      }
      process.exit(1)
    } catch (error) {
      // There was an error and we couldn’t install the dependency. Warn the person.
      console.log('\n ⚠️  [Site.js] Linux: Failed to install Rsync. Please install it manually and run Site.js again.\n', error)
      process.exit(1)
    }
  }

}

module.exports = new Ensure()
