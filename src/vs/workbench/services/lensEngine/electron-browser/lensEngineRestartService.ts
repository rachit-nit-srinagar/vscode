import { ILensEngineRestartService } from '../../../../platform/lensEngine/common/lensEngineRestart.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerMainProcessRemoteService(ILensEngineRestartService, 'lensEngine');
