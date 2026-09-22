/*---------------------------------------------------------------------------------------------
 *  Lens. Proprietary; built on MIT-licensed opencode and VS Code.
 *--------------------------------------------------------------------------------------------*/

import { ILensLiteLlmConfigService } from '../../../../platform/lensEngine/common/lensLiteLlmConfig.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerMainProcessRemoteService(ILensLiteLlmConfigService, 'lensLiteLlmConfig');
