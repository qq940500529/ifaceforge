import { App, Button, Modal } from 'antd';
import { unwrap } from './client.js';
import { useLoad } from './components.js';
import type { Language } from './i18n.js';
import { projectInfo } from '../app/about.js';

const logo = new URL('../../build/icons/icon.png', import.meta.url).href;

export function About({ lang, close }: { lang: Language; close: () => void }) {
  const zh = lang === 'zh-CN';
  const { message } = App.useApp();
  const metadata = useLoad(() => unwrap(window.ifaceforge!.about()), []);
  return (
    <Modal open title={zh ? '关于 IfaceForge' : 'About IfaceForge'} onCancel={close} width={570} footer={null}>
      <div className="about-sheet">
        <div className="about-hero">
          <img src={logo} alt="" width={56} height={56} />
          <div>
            <h2>
              {projectInfo.name} <span>{zh ? '接口工坊' : ''}</span>
            </h2>
            <p>{zh ? '本机 Git 项目的接口与测试工作台' : 'APIs, MCP, and skills in your local Git projects'}</p>
            <div className="about-facts">
              {metadata.data && <code>v{metadata.data.version}</code>}
              {!!metadata.error && <span>{zh ? '无法读取版本' : 'Version unavailable'}</span>}
              <span>
                {projectInfo.license} {zh ? '许可证' : 'License'}
              </span>
            </div>
          </div>
        </div>
        <section className="about-credits" aria-labelledby="about-credits-title">
          <h3 id="about-credits-title">{zh ? '致谢' : 'Acknowledgements'}</h3>
          <p>
            {zh
              ? '感谢开源项目的维护者和贡献者，也感谢提供反馈与复现记录的用户。'
              : 'Thanks to the open-source maintainers and contributors, and to everyone who reported and reproduced issues.'}
          </p>
          <dl>
            <div>
              <dt>{zh ? '桌面与界面' : 'Desktop and UI'}</dt>
              <dd>{projectInfo.acknowledgements.desktop.join(' · ')}</dd>
            </div>
            <div>
              <dt>{zh ? '文档预览' : 'Document preview'}</dt>
              <dd>{projectInfo.acknowledgements.markdown.join(' · ')}</dd>
            </div>
            <div>
              <dt>{zh ? 'Windows 安装' : 'Windows setup'}</dt>
              <dd>{projectInfo.acknowledgements.windowsSetup.join(' · ')}</dd>
            </div>
          </dl>
        </section>
        <div className="about-footer">
          <small>{projectInfo.copyright}</small>
          <Button
            onClick={() =>
              void unwrap(window.ifaceforge!.repository()).catch(() =>
                message.error(zh ? '无法打开项目仓库' : 'Unable to open the repository'),
              )
            }
          >
            {zh ? '项目仓库' : 'Project repository'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
