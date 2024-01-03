/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { IManifestMetadata, getMaximumSafePosition } from "../../../manifest";
import { IMediaSourceInterface, SourceBufferType } from "../../../mse";
import { ITrackType } from "../../../public_types";
import { ITextDisplayer } from "../../../text_displayer";
import arrayFind from "../../../utils/array_find";
import { IRange } from "../../../utils/ranges";
import SharedReference, {
  IReadOnlySharedReference,
} from "../../../utils/reference";
import TaskCanceller, {
  CancellationSignal,
} from "../../../utils/task_canceller";
import {
  IFreezingStatus,
  IPlaybackObservation,
  IReadOnlyPlaybackObserver,
  IRebufferingStatus,
  PlaybackObserver,
} from "../../api";
import { IStreamOrchestratorPlaybackObservation } from "../../stream";

/** Arguments needed to create the core's version of the PlaybackObserver. */
export interface ICorePlaybackObserverArguments {
  /** If true, the player will auto-play when `initialPlayPerformed` becomes `true`. */
  autoPlay : boolean;
  /** Manifest of the content being played */
  manifest : IManifestMetadata;
  /** Becomes `true` after the initial play has been taken care of. */
  initialPlayPerformed : IReadOnlySharedReference<boolean>;
  /** The last speed requested by the user. */
  speed : IReadOnlySharedReference<number>;
  /**
   * Used abstraction to implement text track displaying.
   *
   * `null` if text tracks are disabled
   */
  textDisplayer : ITextDisplayer | null;
  /** Used abstraction for MSE API. */
  mediaSource : IMediaSourceInterface | null;
}

export type ICorePlaybackObservation = IStreamOrchestratorPlaybackObservation & {
  rebuffering: IRebufferingStatus | null;
  freezing: IFreezingStatus | null;
  bufferGap: number | undefined;
};

/**
 * Create PlaybackObserver for the core part of the code.
 * @param {Object} srcPlaybackObserver - Base `PlaybackObserver` from which we
 * will derive information.
 * @param {Object} context - Various information linked to the current content
 * being played.
 * @param {Object} fnCancelSignal - Abort the created PlaybackObserver.
 * @returns {Object}
 */
export default function createCorePlaybackObserver(
  srcPlaybackObserver : PlaybackObserver,
  { autoPlay,
    initialPlayPerformed,
    manifest,
    mediaSource,
    speed,
    textDisplayer } : ICorePlaybackObserverArguments,
  fnCancelSignal : CancellationSignal
) : IReadOnlyPlaybackObserver<ICorePlaybackObservation> {
  return srcPlaybackObserver.deriveReadOnlyObserver(function transform(
    observationRef : IReadOnlySharedReference<IPlaybackObservation>,
    parentObserverCancelSignal : CancellationSignal
  ) : IReadOnlySharedReference<ICorePlaybackObservation> {
    const canceller = new TaskCanceller();
    canceller.linkToSignal(parentObserverCancelSignal);
    canceller.linkToSignal(fnCancelSignal);
    const newRef = new SharedReference(constructCorePlaybackObservation(),
                                       canceller.signal);

    // TODO there might be subtle unexpected behavior here as updating the
    // speed will send observation which may be outdated at the time it is sent
    speed.onUpdate(emitCorePlaybackObservation, {
      clearSignal: canceller.signal,
      emitCurrentValue: false,
    });

    observationRef.onUpdate(emitCorePlaybackObservation, {
      clearSignal: canceller.signal,
      emitCurrentValue: false,
    });
    return newRef;

    function constructCorePlaybackObservation() {
      const observation = observationRef.getValue();
      const lastSpeed = speed.getValue();
      updateWantedPositionIfAfterManifest(observation, manifest);
      return {
        // TODO more exact according to the current Adaptation chosen?
        maximumPosition: getMaximumSafePosition(manifest),
        bufferGap: observation.bufferGap,
        position: observation.position,
        buffered: getBufferedDataPerMediaBuffer(mediaSource, textDisplayer),
        duration: observation.duration,
        rebuffering: observation.rebuffering,
        freezing: observation.freezing,
        paused: { last: observation.paused,
                  pending: getPendingPaused(initialPlayPerformed, autoPlay) },
        readyState: observation.readyState,
        speed: lastSpeed,
      };
    }

    function emitCorePlaybackObservation() {
      newRef.setValue(constructCorePlaybackObservation());
    }
  });
}

export function updateWantedPositionIfAfterManifest(
  observation: IPlaybackObservation,
  manifest: IManifestMetadata
): void  {
  if (!manifest.isDynamic || manifest.isLastPeriodKnown) {
    // HACK: When the position is actually further than the maximum
    // position for a finished content, we actually want to be loading
    // the last segment before ending.
    // For now, this behavior is implicitely forced by making as if we
    // want to seek one second before the period's end (despite never
    // doing it).
    const lastPeriod = manifest.periods[manifest.periods.length - 1];
    if (lastPeriod !== undefined && lastPeriod.end !== undefined) {
      const wantedPosition = observation.position.getWanted();
      if (wantedPosition >= lastPeriod.start &&
          wantedPosition >= lastPeriod.end - 1)
      {
        // We're after the end of the last Period, check if `buffered`
        // indicates that the last segment is probably not loaded, in which
        // case act as if we want to load one second before the end.
        const buffered = observation.buffered;
        if (buffered.length === 0 ||
            buffered.end(buffered.length - 1) < observation.duration - 1)
        {
          observation.position.forceWantedPosition(lastPeriod.end - 1);
        }
      }
    }
  }
}

export function getPendingPaused(
  initialPlayPerformed: IReadOnlySharedReference<boolean>,
  autoPlay: boolean
): boolean | undefined {
  return initialPlayPerformed.getValue() ? undefined :
                                           !autoPlay;
}

export function getBufferedDataPerMediaBuffer(
  mediaSourceInterface: IMediaSourceInterface | null,
  textDisplayer: ITextDisplayer | null
): Record<ITrackType, IRange[] | null> {
  const buffered: Record<ITrackType, IRange[] | null> = {
    audio: null,
    video: null,
    text: null,
  };
  if (textDisplayer !== null) {
    buffered.text = textDisplayer.getBufferedRanges();
  }
  if (mediaSourceInterface === null) {
    return buffered;
  }
  const audioBuffer = arrayFind(mediaSourceInterface.sourceBuffers,
                                s => s.type === SourceBufferType.Audio);
  const videoBuffer = arrayFind(mediaSourceInterface.sourceBuffers,
                                s => s.type === SourceBufferType.Video);
  const audioBuffered = audioBuffer?.getBuffered();
  if (audioBuffered !== undefined) {
    buffered.audio = audioBuffered;
  }
  const videoBuffered = videoBuffer?.getBuffered();
  if (videoBuffered !== undefined) {
    buffered.video = videoBuffered;
  }
  return buffered;
}