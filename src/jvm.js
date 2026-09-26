'use strict';

const { recommendRam } = require('./system');

function getFpsJvmArgs(opts = {}) {
  const profile = opts.profile || 'balanced';
  const javaMajor = opts.javaMajor || 17;
  const cpuCores = opts.cpuCores || 4;
  const modded = !!opts.modded;
  const ramMb = opts.ramMb || recommendRam({ totalMb: opts.totalRamMb, modded, profile });

  const args = [];

  const xms = profile === 'potato' ? Math.floor(ramMb / 2) : ramMb;
  args.push(`-Xms${xms}M`, `-Xmx${ramMb}M`);

  if (javaMajor >= 21 && profile !== 'potato' && cpuCores >= 8) {
    args.push(
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseZGC',
      '-XX:+ZGenerational',
      '-XX:ZAllocationSpikeTolerance=2.0'
    );
  } else if (javaMajor >= 21 && profile === 'maxfps' && cpuCores >= 6) {
    args.push(
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseZGC',
      '-XX:+ZGenerational'
    );
  } else {
    args.push('-XX:+UseG1GC');
    const g1New = profile === 'potato' ? '30' : '40';
    const g1MaxNew = profile === 'potato' ? '40' : '50';
    args.push(
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=100',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      `-XX:G1NewSizePercent=${g1New}`,
      `-XX:G1MaxNewSizePercent=${g1MaxNew}`,
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem',
      '-XX:MaxTenuringThreshold=1'
    );
    if (profile === 'potato' && cpuCores <= 4) {
      args.push(`-XX:ParallelGCThreads=${Math.min(2, cpuCores)}`, `-XX:ConcGCThreads=1`);
    }
  }

  args.push(
    '-XX:+TieredCompilation',
    '-XX:TieredStopAtLevel=4',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true'
  );

  args.push(
    '-Dfile.encoding=UTF-8',
    '-Djava.util.concurrent.ForkJoinPool.common.parallelism=' + Math.max(1, cpuCores - 1)
  );


  if (process.platform === 'win32') {
    args.push('-Dorg.lwjgl.opengl.Window.undecorated=false');
  }

  return { ramMb, xmsMb: xms, args };
}

function processPriorityHint(profile) {
  return profile === 'potato' || profile === 'balanced' ? 'HIGH' : 'ABOVE_NORMAL';
}

module.exports = { getFpsJvmArgs, processPriorityHint };
