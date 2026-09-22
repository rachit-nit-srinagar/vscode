/*---------------------------------------------------------------------------------------------
 *  Lens. Proprietary; built on MIT-licensed opencode and VS Code.
 *--------------------------------------------------------------------------------------------*/

import { ILensEngineRestartService } from '../../../../platform/lensEngine/common/lensEngineRestart.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerMainProcessRemoteService(ILensEngineRestartService, 'lensEngine');
