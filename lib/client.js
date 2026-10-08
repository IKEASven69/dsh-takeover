window.__ModuleLoader__.load({
	id: "dsh-takeover",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name in all)
		    __defProp(target, name, { get: all[name], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
		
		// src/client.ts
		var client_exports = {};
		__export(client_exports, {
		  apply: () => apply,
		  buildReportHtml: () => buildReportHtml,
		  coverageTextOf: () => coverageTextOf,
		  envelopeCharsOf: () => envelopeCharsOf,
		  inject: () => inject,
		  reportWords: () => reportWords
		});
		module.exports = __toCommonJS(client_exports);
		var import_react = require("react");
		
		// src/brand-icons.ts
		var BRAND_MARKS = {
		  claude: { viewBox: "0 0 24 24", tile: "#D97757", paths: [{ d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", fill: "#fff" }] },
		  codex: { viewBox: "0 0 24 24", tile: "#0f0f0f", paths: [{ d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z", fill: "#fff" }] },
		  cursor: { viewBox: "0 0 24 24", tile: "#1a1a1a", paths: [{ d: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23", fill: "#fff" }] },
		  opencode: {
		    viewBox: "0 0 512 512",
		    tile: "#131010",
		    paths: [
		      // 白色方环即 opencode favicon 的全部可见形态（曾误塞一条 d="#5A5858" 的颜色串当「芯」，
		      // 浏览器对非法 path data 静默忽略——删掉让代码与渲染一致）
		      { d: "M384 416H128V96H384V416ZM320 160H192V352H320V160Z", fill: "#fff" }
		    ]
		  },
		  zcode: {
		    viewBox: "0 0 30 30",
		    tile: "#2D2D2D",
		    paths: [
		      { d: "M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z", fill: "#fff" },
		      { d: "M24.3 7.1L13.14 22.91L5.7 22.91L16.86 7.1Z", fill: "#fff" },
		      { d: "M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z", fill: "#fff" }
		    ]
		  },
		  pi: {
		    viewBox: "0 0 800 800",
		    tile: "#27272a",
		    paths: [
		      { d: "M165.29 165.29H517.36V400H400V282.65H165.29Z", fill: "#F09082" },
		      { d: "M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z", fill: "#4D9ABF" },
		      { d: "M517.36 400H634.72V634.72H517.36Z", fill: "#F1BE58" }
		    ]
		  },
		  dsh: { viewBox: "0 0 23.16 17.04", tile: "#4D6BFE", paths: [{ d: "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z", fill: "#fff" }] },
		  grok: { viewBox: "0 0 256 246", tile: "#111111", paths: [{ d: "M63.8307299,56.8426545 C91.2989169,29.362978 131.465298,21.9776085 165.542128,34.9726459 L167.855892,35.8902557 C175.501463,38.7335174 182.164746,42.7796414 187.363427,46.5414469 L158.506099,59.882758 C131.637157,48.5973415 100.857492,56.2740175 82.0711204,75.0832754 C56.6656274,100.496833 51.5320736,144.566967 81.3069473,173.04336 L-1.42108547e-14,245.764227 C4.29613789,239.840925 9.45698399,234.190695 14.7493257,228.586421 L20.5645541,222.456072 L23.1726477,219.681571 C38.703877,203.027306 51.983468,185.912092 43.6693415,162.973056 L42.9033683,160.992465 C28.3109637,125.495663 36.8086459,83.896995 63.8307299,56.8426545 Z M220.785826,35.2560304 L256,0 L245.871984,14.068605 C224.778304,43.78544 215.415895,62.4930162 224.761831,102.727911 L224.69655,102.66263 C231.927394,133.390838 224.194269,167.466048 199.225391,192.464878 C167.746834,224.002573 117.372848,231.022982 75.8893821,202.634909 L104.811992,189.227703 C131.287711,199.638122 160.254097,195.066907 181.071863,174.224565 C201.890397,153.381454 206.565294,123.024196 196.101882,97.7634735 C194.113496,92.9733751 188.149873,91.7706665 183.977257,94.8542395 L98.8698734,157.755289 L220.785826,35.1466653 L220.785826,35.2560304 Z", fill: "#fff" }] }
		};
		var BRAND_FULL_SVG = {
		  workbuddy: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">\n<g clip-path="url(#clip0_542_3370)">\n<rect width="40" height="40" rx="20" fill="url(#paint0_linear_542_3370)"/>\n<g filter="url(#filter0_f_542_3370)">\n<circle cx="31.3411" cy="43.6183" r="12.8704" fill="#FFE355" fill-opacity="0.49" style="fill:#FFE355;fill:color(display-p3 1.0000 0.8891 0.3348);fill-opacity:0.49;"/>\n</g>\n<path d="M28.5931 3.12762C28.9853 2.77585 29.0091 2.76226 29.2968 2.74499C29.7628 2.71096 30.1894 2.93488 30.916 3.59634C32.6132 5.13875 34.9769 8.30904 36.4462 11.0168L37.0138 12.0682L37.8156 12.4668C38.5896 12.8579 39.8593 13.6593 40.3898 14.0895C40.6297 14.2878 40.6638 14.2925 40.9133 14.1954C42.0388 13.7572 43.6506 14.3382 45.0727 15.7024C46.3529 16.9294 47.5794 19.026 48.0491 20.7757C48.1177 21.0574 48.2087 21.6628 48.2419 22.1134C48.349 23.6964 47.8414 24.9608 46.8637 25.5331C46.664 25.6484 46.6505 25.6795 46.6561 26.1774C46.7011 28.5481 46.0621 30.9144 44.7785 33.2221C43.3293 35.8133 40.7489 38.4945 37.2566 41.0199C35.3813 42.3846 30.9445 44.9701 28.9382 45.8778C24.1324 48.0414 20.2794 48.8709 16.9329 48.4609C14.9368 48.219 12.6769 47.44 11.34 46.5355C10.9885 46.2925 10.9325 46.2774 10.6637 46.3543C9.2327 46.7651 7.35867 45.9207 5.76659 44.1535C5.13165 43.4471 4.1065 41.7127 3.77404 40.7843C3.0054 38.6118 3.15852 36.6506 4.18236 35.4799C4.44671 35.1785 4.45511 35.1658 4.39735 34.6589C4.30195 33.8289 4.25837 32.6008 4.30192 31.808L4.33666 31.0674L3.22502 29.101C1.5033 26.0375 0.409325 23.4645 -0.012563 21.4992C-0.235219 20.4218 -0.221193 19.9436 0.0522186 19.5899C0.21871 19.3763 0.764928 19.1545 1.42322 19.0329C3.08041 18.742 6.69466 19.0056 10.7155 19.7155L11.1329 19.788L12.0511 18.976C13.5747 17.6264 14.587 16.8696 16.4531 15.706C18.3981 14.4891 20.5929 13.4877 23.0648 12.695L23.8577 12.4414L24.2939 11.2964C25.8547 7.17615 27.4533 4.13844 28.5931 3.12762ZM15.5182 24.243C13.7542 25.2615 12.8718 25.7706 12.2236 26.3413C9.59893 28.6526 8.61811 32.3134 9.73545 35.6274C10.0114 36.4457 10.5201 37.3283 11.5386 39.0923C12.5571 40.8564 13.0671 41.7383 13.6378 42.3864C15.9491 45.0112 19.6103 45.9929 22.9243 44.8755C23.7426 44.5995 24.6249 44.0899 26.3888 43.0714L36.5375 37.2121C38.3016 36.1936 39.184 35.6845 39.8321 35.1137C42.4568 32.8024 43.4373 29.1409 42.3198 25.8269C42.0438 25.0086 41.5342 24.1264 40.5158 22.3624C39.4973 20.5983 38.9882 19.7159 38.4175 19.0678C36.1062 16.4432 32.4454 15.4622 29.1314 16.5796C28.3131 16.8556 27.431 17.3651 25.6669 18.3836L15.5182 24.243Z" fill="url(#paint1_linear_542_3370)"/>\n<rect x="16.4961" y="31.3344" width="4.00904" height="8.32646" rx="2.00452" transform="rotate(-30 16.4961 31.3344)" fill="white" style="fill:white;fill-opacity:1;"/>\n<rect x="27.3125" y="25.0894" width="4.00904" height="8.32646" rx="2.00452" transform="rotate(-30 27.3125 25.0894)" fill="white" style="fill:white;fill-opacity:1;"/>\n</g>\n<defs>\n<filter id="filter0_f_542_3370" x="7.47033" y="19.7475" width="47.742" height="47.7416" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">\n<feFlood flood-opacity="0" result="BackgroundImageFix"/>\n<feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>\n<feGaussianBlur stdDeviation="5.50019" result="effect1_foregroundBlur_542_3370"/>\n</filter>\n<linearGradient id="paint0_linear_542_3370" x1="20" y1="0" x2="20" y2="40" gradientUnits="userSpaceOnUse">\n<stop stop-color="#0EC8A9" style="stop-color:#0EC8A9;stop-color:color(display-p3 0.0565 0.7837 0.6625);stop-opacity:1;"/>\n<stop offset="1" stop-color="#01C886" style="stop-color:#01C886;stop-color:color(display-p3 0.0021 0.7858 0.5246);stop-opacity:1;"/>\n</linearGradient>\n<linearGradient id="paint1_linear_542_3370" x1="14.6642" y1="11.0783" x2="33.3762" y2="43.4885" gradientUnits="userSpaceOnUse">\n<stop stop-color="white" stop-opacity="0.8" style="stop-color:white;stop-opacity:0.8;"/>\n<stop offset="0.437689" stop-color="white" style="stop-color:white;stop-opacity:1;"/>\n</linearGradient>\n<clipPath id="clip0_542_3370">\n<rect width="40" height="40" rx="20" fill="white" style="fill:white;fill-opacity:1;"/>\n</clipPath>\n</defs>\n</svg>'
		};
		var PROVIDER_LABEL = {
		  claude: "Claude Code",
		  codex: "Codex CLI",
		  opencode: "OpenCode",
		  zcode: "ZCode",
		  pi: "Pi",
		  workbuddy: "WorkBuddy",
		  cursor: "Cursor",
		  grok: "Grok CLI",
		  dsh: "DeepSeek Harness"
		};
		
		// src/locales.ts
		var NS = "dsh-takeover";
		var zh = {
		  appTitle: "dsh-takeover \u4F1A\u8BDD\u63A5\u7BA1",
		  appSubtitle: "\u547D\u4EE4\u901F\u89C8 \xB7 \u4EA4\u63A5\u5361\u7247\u6536\u4EF6\u7BB1 \xB7 \u516B\u5BB6\u5916\u90E8 agent \u4F1A\u8BDD\u8BFB\u53D6\u5668\u5F00\u5173",
		  refresh: "\u27F3 \u5237\u65B0",
		  cmdTitle: "\u547D\u4EE4\u901F\u89C8",
		  cmdBadge: "\u4F1A\u8BDD\u91CC\u7528\uFF0C\u5361\u7247\u53EA\u8BFB",
		  cmdHandoffDesc: "\u5BC4\u5B58\u5F53\u524D\u4F1A\u8BDD \u2192 \u6536\u4EF6\u7BB1",
		  cmdInboxDesc: "\u5F00\u5C40\u53D6\u4EF6\uFF08\u6D88\u8D39\u5373\u5F03\uFF09",
		  cmdResumeDesc: "\u62C9\u53D6 {name} \u4F1A\u8BDD",
		  cmdOffTitle: "{label} \u5DF2\u5728\u652F\u6301\u77E9\u9635\u505C\u7528\uFF0C\u547D\u4EE4\u4F1A\u8FD4\u56DE\u300C\u5DF2\u505C\u7528\u300D",
		  inboxTitle: "\u6536\u4EF6\u7BB1\u6982\u89C8",
		  badgePending: "\u5F85\u53D6\u4EF6 {n}",
		  badgeArchived: "\u5DF2\u6D88\u8D39 {n}",
		  pendingDupChip: "\u91CD\u590D {n}",
		  pendingDupTitle: "\u540C id \u91CD\u590D\u6587\u4EF6\u5DF2\u6309\u9996\u89C1\u53BB\u91CD\u2014\u2014\u591A\u65B9\u53EF\u5199\u6536\u4EF6\u7BB1\u7684\u9632\u5FA1\u8BA1\u6570",
		  pendingDirHint: "\u5BF9\u5E94\u76EE\u5F55 ~/.handoff/pending/",
		  archivedDirHint: "\u5BF9\u5E94\u76EE\u5F55 ~/.handoff/archived/",
		  clearArchived: "\u6E05\u7A7A\u5DF2\u6D88\u8D39",
		  clearConfirm: "\u786E\u8BA4\u6E05\u7A7A {n} \u5F20\uFF1F",
		  clearArchivedTitle: "\u5220\u9664 archived/ \u76EE\u5F55\u4E0B\u5168\u90E8\u5DF2\u6D88\u8D39\u5361\u7247\uFF08\u4E0D\u53EF\u6062\u590D\uFF09",
		  emptyInbox: "\u{1F4ED} \u6536\u4EF6\u7BB1\u4E3A\u7A7A\u3002\u53D6\u4EF6\u4E0D\u5728\u6B64\u8FDB\u884C\u2014\u2014\u5728\u4F1A\u8BDD\u91CC\u7528 /inbox \u6D88\u8D39\u5373\u53D6\u3002",
		  from: "\u6765\u6E90 {name}",
		  project: "\u9879\u76EE {name}",
		  idLabel: "\u7F16\u53F7 {id}",
		  previewEmpty: "\uFF08\u5361\u7247\u6B63\u6587\u4E3A\u7A7A\uFF09",
		  previewHint: "\u2014\u2014 \u9884\u89C8\u53D6\u81EA\u300C\u76EE\u6807\u300D\u6BB5\uFF08\u76EE\u6807\u6BB5\u4E3A\u7A7A\u65F6\u56DE\u9000\u300C\u505A\u5230\u54EA\u300D\u6BB5\uFF09\uFF1B\u53D6\u4EF6\u8BF7\u56DE\u4F1A\u8BDD\u7528 /inbox\u3002",
		  filterPlaceholder: "\u8FC7\u6EE4\uFF1A\u6807\u9898 / \u6765\u6E90 / \u7F16\u53F7\u2026",
		  filterAria: "\u6536\u4EF6\u7BB1\u5373\u65F6\u8FC7\u6EE4\uFF08\u5339\u914D\u6807\u9898\u3001\u6765\u6E90\u540D\u6216\u7F16\u53F7\uFF0C\u6E05\u7A7A\u5373\u6062\u590D\u5168\u90E8\uFF09",
		  chipAll: "\u5168\u90E8",
		  newOnlyChip: "\u53EA\u770B\u65B0\u5361",
		  chipSourceAria: "\u6309\u6765\u6E90\u7B5B\u9009\u5F85\u53D6\u4EF6",
		  filterEmpty: "\u6CA1\u6709\u5339\u914D\u7684\u5361\u7247\u2014\u2014\u6E05\u7A7A\u8FC7\u6EE4\u6846\u53EF\u6062\u590D\u5168\u90E8",
		  newBadge: "\u65B0",
		  groupCount: "\u5171 {n} \u5F20",
		  groupAria: "{title}\uFF0C\u5171 {n} \u5F20",
		  unknownSource: "\uFF08\u672A\u77E5\u6765\u6E90\uFF09",
		  lowInfoGroup: "\u4F4E\u4FE1\u606F\u5361\uFF08{n}\uFF09\u2014\u2014\u516D\u6BB5\u5168\u662F\u5360\u4F4D\uFF0C\u591A\u534A\u662F\u8BEF\u89E6\u5BC4\u5B58",
		  lowInfoBadge: "\u4F4E\u4FE1\u606F",
		  exportCard: "\u5BFC\u51FA .md",
		  exportCardTitle: "\u4E0B\u8F7D\u8BE5\u5361\u7247\u4E3A .md\uFF08frontmatter + \u516D\u6BB5\uFF1Bstate \u672A\u542B\u7684\u6BB5\u5168\u6587\u5C31\u5730\u6CE8\u660E\uFF0C\u4E0D\u81C6\u9020\uFF09",
		  exportAll: "\u5BFC\u51FA\u5168\u90E8",
		  exportAllTitle: "\u628A\u5168\u90E8\u5F85\u53D6\u4EF6\u5361\u7247\u62FC\u6210\u4E00\u4E2A .md \u4E0B\u8F7D\uFF08\u96F6\u4F9D\u8D56\uFF0C\u7EAF\u524D\u7AEF\u751F\u6210\uFF09",
		  exportNoteTop: "> \u672C\u6587\u4EF6\u7531 dsh-takeover \u8BBE\u7F6E\u5361\u5BFC\u51FA\uFF0C\u4EC5\u542B\u6536\u4EF6\u7BB1 state \u63D0\u4F9B\u7684\u5B57\u6BB5\uFF1A\u7F16\u53F7 / \u6765\u6E90 / \u6807\u9898 / \u9879\u76EE / \u63A8\u9001\u65F6\u95F4\uFF0C\u4EE5\u53CA\u300C\u76EE\u6807\u300D\u6BB5\u9884\u89C8\uFF08\u670D\u52A1\u7AEF\u622A 240 \u5B57\uFF1B\u76EE\u6807\u6BB5\u4E3A\u7A7A\u65F6\u56DE\u9000\u300C\u505A\u5230\u54EA\u300D\u6BB5\uFF09\u3002\u6765\u6E90\u4F1A\u8BDD\u3001cwd\u3001git \u5FEB\u7167\u3001tasks \u4E0E\u5176\u4F59\u4E94\u6BB5\u5168\u6587\u4E0D\u5728 state \u5185\uFF0C\u672A\u4F5C\u81C6\u9020\u2014\u2014\u5B8C\u6574\u5361\u7247\u8BF7\u56DE\u4F1A\u8BDD\u7528 /inbox \u53D6\u4EF6\u3002",
		  exportSectionMissing: "\uFF08\u8BE5\u6BB5\u5168\u6587\u4E0D\u5728\u6B64\u6587\u4EF6\uFF1A\u8BBE\u7F6E\u5361 state \u672A\u63D0\u4F9B\u3002\u56DE\u4F1A\u8BDD\u7528 /inbox \u53D6\u4EF6\u67E5\u770B\u5B8C\u6574\u5361\u7247\u3002\uFF09",
		  exportHtml: "\u5BFC\u51FA HTML \u62A5\u544A",
		  exportHtmlTitle: "\u751F\u6210\u81EA\u5305\u542B\u5355\u6587\u4EF6 HTML \u62A5\u544A\u5E76\u4E0B\u8F7D\uFF08\u516B\u5BB6\u652F\u6301\u77E9\u9635 + \u5168\u90E8\u5F85\u53D6\u4EF6\u5361\u7247 + \u5DF2\u6D88\u8D39\u8BA1\u6570\uFF1B\u96F6\u4F9D\u8D56\u7EAF\u524D\u7AEF\u751F\u6210\uFF0C\u5185\u5BB9\u4E0E state \u9010\u5B57\u6BB5\u4E00\u81F4\uFF09",
		  envelopeArchived: "\u673A\u5668\u4FE1\u5C01\u5DF2\u968F\u5361\u5F52\u6863\uFF08{n} chars\uFF09",
		  coverageBadge: "\u8986\u76D6\u7387 {v}",
		  coverageBadgeTitle: "\u56DB\u6001\u8986\u76D6\u7387\uFF1Adone \u6BB5\u9648\u8FF0\u7684\u8D26\u672C\u72B6\u6001\u6807\u6CE8\u6BD4\u4F8B\uFF08x/y\uFF1Bhost \u4FA7\u6570\u636E\u843D\u5730\u540E\u663E\u793A\uFF09",
		  matrixTitle: "\u652F\u6301\u77E9\u9635\uFF08\u516B\u5BB6\u8BFB\u53D6\u5668\uFF09",
		  browserTitle: "\u5916\u90E8\u4F1A\u8BDD\u6D4F\u89C8\u5668",
		  browserHint: "\u6D4F\u89C8 + \u4E00\u952E\u63A5\u7BA1\uFF1A\u70B9\u4E00\u5BB6\u8BFB\u53D6\u5668\u5217\u51FA\u672C\u673A\u6700\u8FD1\u4F1A\u8BDD\uFF0C\u300C\u63A5\u7BA1\u300D\u76F4\u63A5\u6295\u9012\u65B0\u4F1A\u8BDD\uFF08\u5931\u8D25\u81EA\u52A8\u9000\u56DE\u590D\u5236\u6307\u4EE4\uFF09\u2014\u2014\u5361\u7247\u7531\u6A21\u578B\u84B8\u998F\uFF0C\u8D28\u91CF\u8DDF\u6A21\u578B\u80FD\u529B\u8D70\u3002",
		  browserPick: "\u70B9\u4E0A\u65B9\u4E00\u5BB6\u8BFB\u53D6\u5668\u5F00\u59CB\u6D4F\u89C8\uFF08\u9ED8\u8BA4\u4E0D\u81EA\u52A8\u626B\u63CF\u516B\u5BB6\uFF09",
		  browserEmpty: "\u8BE5\u8BFB\u53D6\u5668\u672C\u673A\u6CA1\u6709\u53D1\u73B0\u4F1A\u8BDD",
		  browserTotal: "\u5171 {m} \u4E2A\uFF0C\u663E\u793A\u6700\u8FD1 {n} \u4E2A",
		  browserNote: "\u63D0\u793A\uFF1A{note}",
		  browserChipAria: "\u9009\u62E9\u8981\u6D4F\u89C8\u7684\u8BFB\u53D6\u5668",
		  browserFilterEmpty: "\u6CA1\u6709\u5339\u914D\u7684\u4F1A\u8BDD\u2014\u2014\u6E05\u7A7A\u8FC7\u6EE4\u6846\u53EF\u6062\u590D\u5168\u90E8",
		  browserDisabledTitle: "{label} \u5DF2\u505C\u7528\u6216\u672C\u673A\u4E0D\u652F\u6301\uFF0C\u4E0D\u53EF\u6D4F\u89C8",
		  filterSessionsPlaceholder: "\u8FC7\u6EE4\uFF1A\u6807\u9898 / \u76EE\u5F55 / id\u2026",
		  filterSessionsAria: "\u5916\u90E8\u4F1A\u8BDD\u5373\u65F6\u8FC7\u6EE4\uFF08\u5339\u914D\u6807\u9898\u3001\u76EE\u5F55\u6216 id\uFF0C\u6E05\u7A7A\u5373\u6062\u590D\u5168\u90E8\uFF09",
		  takeoverBtn: "\u63A5\u7BA1",
		  takeoverTitle: "\u4E00\u952E\u6295\u9012\u5230\u65B0\u4F1A\u8BDD\uFF08\u5931\u8D25\u81EA\u52A8\u9000\u56DE\u590D\u5236\u6307\u4EE4\uFF09",
		  depositBtn: "\u63A5\u7BA1\u5E76\u5BC4\u5B58",
		  depositTitle: "\u4E00\u952E\u6295\u9012\u4E24\u884C\u6307\u4EE4\uFF1A\u63A5\u7BA1\u5B8C\u6210\u540E\u81EA\u52A8\u5BC4\u5B58\uFF08\u5931\u8D25\u81EA\u52A8\u9000\u56DE\u590D\u5236\uFF09",
		  deliveringBtn: "\u6295\u9012\u4E2D\u2026",
		  deliveredBtn: "\u5DF2\u6295\u9012 \u2713",
		  fallbackCopyBtn: "\u5DF2\u590D\u5236\uFF08\u964D\u7EA7\uFF09",
		  fallbackNotice: "\u4E00\u952E\u6295\u9012\u5931\u8D25\uFF08{reason}\uFF09\uFF0C\u5DF2\u81EA\u52A8\u9000\u56DE\u590D\u5236\u6307\u4EE4",
		  copiedBtn: "\u5DF2\u590D\u5236 \u2713",
		  copyIdTitle: "\u70B9\u51FB\u590D\u5236\u5B8C\u6574\u4F1A\u8BDD id",
		  previewTurns: "\u8F6E\u6570 {n}\uFF08\u7528\u6237 {u}\uFF09",
		  previewFirst: "\u9996\u6761\u7528\u6237\u8BF7\u6C42",
		  previewTail: "\u5C3E\u90E8\u8FDB\u5C55",
		  previewStop: "\u505C\u5728\u54EA",
		  previewLoadFail: "\u9884\u89C8\u5931\u8D25",
		  deliveredNotice: "\u5DF2\u521B\u5EFA\u4F1A\u8BDD\u300C{title}\u300D\u5E76\u6295\u9012\u2014\u2014\u53BB\u4F1A\u8BDD\u6811\u70B9\u5B83\u67E5\u770B\u63A5\u7BA1\u8FDB\u5EA6",
		  inboxTakeBtn: "\u4E00\u952E\u53D6\u4EF6",
		  inboxTakeTitle: "\u65B0\u5EFA\u4F1A\u8BDD\u5E76\u6295\u9012 /inbox\uFF08\u6D88\u8D39\u5373\u5F03\uFF09",
		  chainBadge: "\u2190 \u63A5\u529B\u81EA {id}",
		  chainBadgeTitle: "\u672C\u5361\u63A5\u66FF\u524D\u7F6E\u5361 {id}\uFF08\u63A5\u529B\u94FE\uFF09",
		  chainFilterBtn: "\u53EA\u770B\u6B64\u94FE",
		  chainFilterTitle: "\u628A\u8FC7\u6EE4\u8BCD\u8BBE\u4E3A {id}\uFF0C\u53EA\u770B\u8FD9\u6761\u63A5\u529B\u94FE\u7684\u76F8\u5173\u5361",
		  subagentBadge: "\u5B50\u4EE3\u7406",
		  subagentGroup: "\u5B50\u4EE3\u7406\u4F1A\u8BDD\uFF08{n}\uFF09",
		  facetCwdAria: "\u6309\u9879\u76EE\u7B5B\u9009\u4F1A\u8BDD",
		  sessionsCount: "{n} \u4E2A\u4F1A\u8BDD",
		  sessionsProbeFail: "\u4F1A\u8BDD\u6570\u63A2\u6D4B\u5931\u8D25",
		  unsupported: "\u672C\u673A\u4E0D\u652F\u6301",
		  unsupportedNote: "\u672C\u673A\u4E0D\u652F\u6301\uFF1A{note}",
		  pillOk: "\u652F\u6301",
		  pillNo: "\u4E0D\u53EF\u7528",
		  toggleDisable: "\u70B9\u51FB\u505C\u7528 {label}\uFF08foreign_session_read \u5C06\u8FD4\u56DE\u300C\u5DF2\u505C\u7528\u300D\uFF09",
		  toggleEnable: "\u70B9\u51FB\u542F\u7528 {label}",
		  toggleAria: "{label}\uFF08{id}\uFF09\u8BFB\u53D6\u5F00\u5173",
		  noteSummary: "\u{1F4A1} \u5F00\u5173\u8BED\u4E49\u8BF4\u660E",
		  noteBody: "\u5173\u6389\u7684 provider\uFF1Aforeign_session_read \u5BF9\u8BE5\u5BB6\u8FD4\u56DE\u89C4\u8303\u9519\u8BEF\u503C\u300C\u5DF2\u505C\u7528\u300D\uFF1B/resume-* \u5BF9\u5E94 skill \u7684\u6307\u5F15\u6587\u672C\u4E3A\u9759\u6001\u5185\u5BB9\uFF0C\u505C\u7528\u72B6\u6001\u7531\u5DE5\u5177\u62A5\u9519\u515C\u4F4F\uFF0C\u6A21\u578B\u53EF\u89C1\u3002\u4F1A\u8BDD\u6570\u4E3A 0 \u7684\u7070\u8272\u884C\u8868\u793A\u8BE5\u5BB6\u672C\u673A\u672A\u88C5\u6216\u6682\u65E0\u4F1A\u8BDD\uFF0C\u5F00\u5173\u4FDD\u7559\u4F46\u65E0\u6570\u636E\u53EF\u8BFB\u3002",
		  loading: "\u52A0\u8F7D\u4E2D\u2026",
		  noTime: "\uFF08\u65E0\u65F6\u95F4\uFF09",
		  renderErrorTitle: "dsh-takeover \u6E32\u67D3\u51FA\u9519\uFF08\u628A\u4E0B\u9762\u8FD9\u6BB5\u53D1\u7ED9\u7EF4\u62A4\u8005\uFF09",
		  reportTitle: "dsh-takeover \u4EA4\u63A5\u62A5\u544A",
		  reportSubtitle: "\u4F1A\u8BDD\u63A5\u7BA1\u6536\u4EF6\u7BB1\u5FEB\u7167\uFF08\u516B\u5BB6\u8BFB\u53D6\u5668 \xB7 \u5F85\u53D6\u4EF6\u5361\u7247 \xB7 \u5DF2\u6D88\u8D39\u8BA1\u6570\uFF09",
		  reportGenerated: "\u751F\u6210\u4E8E {n}",
		  reportNote: "\u672C\u62A5\u544A\u7531 dsh-takeover \u8BBE\u7F6E\u5361\u5BFC\u51FA\uFF0C\u4E3A\u81EA\u5305\u542B\u5355\u6587\u4EF6 HTML\uFF0C\u5185\u5BB9\u4EC5\u6765\u81EA /dsh-takeover/state \u5F53\u524D\u8FD4\u56DE\uFF1A\u5F85\u53D6\u4EF6\u5361\u7247\uFF08\u7F16\u53F7 / \u6765\u6E90 / \u6807\u9898 / \u9879\u76EE / \u63A8\u9001\u65F6\u95F4\u4E0E\u300C\u76EE\u6807\u300D\u6BB5\u9884\u89C8\uFF09\u3001\u516B\u5BB6\u652F\u6301\u77E9\u9635\u4E0E\u5DF2\u6D88\u8D39\u8BA1\u6570\u3002\u5361\u7247\u5176\u4F59\u4E94\u6BB5\u5168\u6587\u3001\u6765\u6E90\u4F1A\u8BDD\u4E0E git \u5FEB\u7167\u4E0D\u5728 state \u5185\uFF0C\u672A\u4F5C\u81C6\u9020\u2014\u2014\u5B8C\u6574\u5361\u7247\u8BF7\u56DE\u4F1A\u8BDD\u7528 /inbox \u53D6\u4EF6\u3002",
		  reportStatPending: "\u5F85\u53D6\u4EF6",
		  reportStatArchived: "\u5DF2\u6D88\u8D39",
		  reportStatProviders: "\u8BFB\u53D6\u5668\uFF08\u5DF2\u542F\u7528/\u603B\u6570\uFF09",
		  reportPendingEmpty: "\u6536\u4EF6\u7BB1\u4E3A\u7A7A\u2014\u2014\u5F53\u524D\u6CA1\u6709\u5F85\u53D6\u4EF6\u5361\u7247\u3002",
		  reportSkipped: "\u53E6\u6709 {n} \u5F20\u65E0\u6CD5\u89E3\u6790\u7684\u5361\u7247\u88AB\u8DF3\u8FC7\uFF08\u4E0D\u8BA1\u5165\u4E0B\u65B9\u5217\u8868\uFF09",
		  reportLabelFrom: "\u6765\u6E90",
		  reportLabelProject: "\u9879\u76EE",
		  reportLabelTime: "\u63A8\u9001\u65F6\u95F4",
		  reportLabelPreview: "\u76EE\u6807\u9884\u89C8",
		  reportDisabled: "\u5DF2\u505C\u7528"
		};
		var en = {
		  appTitle: "dsh-takeover Session Takeover",
		  appSubtitle: "Commands \xB7 Handoff card inbox \xB7 Reader switches for 8 external agent CLIs",
		  refresh: "\u27F3 Refresh",
		  cmdTitle: "Commands",
		  cmdBadge: "Run in sessions \u2014 this card is read-only",
		  cmdHandoffDesc: "Park this session \u2192 inbox",
		  cmdInboxDesc: "Pick up at start (consumed once)",
		  cmdResumeDesc: "Pull {name} sessions",
		  cmdOffTitle: '{label} is off in the matrix; the command returns "disabled"',
		  inboxTitle: "Inbox overview",
		  badgePending: "Pending {n}",
		  badgeArchived: "Consumed {n}",
		  pendingDupChip: "Dup {n}",
		  pendingDupTitle: "Same-id duplicates deduped to first seen \u2014 multi-writer defensive count",
		  pendingDirHint: "maps to ~/.handoff/pending/",
		  archivedDirHint: "maps to ~/.handoff/archived/",
		  clearArchived: "Clear consumed",
		  clearConfirm: "Clear {n}?",
		  clearArchivedTitle: "Delete every consumed card under archived/ (irreversible)",
		  emptyInbox: "\u{1F4ED} Inbox is empty. Pickup does not happen here \u2014 run /inbox in a session to consume.",
		  from: "from {name}",
		  project: "project {name}",
		  idLabel: "id {id}",
		  previewEmpty: "(card body is empty)",
		  previewHint: "\u2014 Preview from the goal section (falls back to the done section when the goal is empty); run /inbox in a session to claim.",
		  filterPlaceholder: "Filter: title / source / id\u2026",
		  filterAria: "Instant inbox filter (matches title, source name, or id; clear to restore)",
		  chipAll: "All",
		  newOnlyChip: "New only",
		  chipSourceAria: "Filter pending cards by source",
		  filterEmpty: "No matching cards \u2014 clear the filter to restore the full list",
		  newBadge: "NEW",
		  groupCount: "{n} cards",
		  groupAria: "{title}, {n} cards",
		  unknownSource: "(unknown source)",
		  lowInfoGroup: "Low-info cards ({n}) \u2014 all-placeholder sections, likely accidental",
		  lowInfoBadge: "low-info",
		  exportCard: "Export .md",
		  exportCardTitle: "Download this card as .md (frontmatter + 6 sections; sections not in state are noted in place, never invented)",
		  exportAll: "Export all",
		  exportAllTitle: "Download every pending card as one .md (zero-dependency, generated in the browser)",
		  exportNoteTop: '> Exported by the dsh-takeover settings card. Contains only the fields provided by the inbox state: id / source / title / project / push time, plus the "goal" section preview (server-truncated to 240 chars; falls back to the "done" section when the goal is empty). The source session, cwd, git snapshot, tasks and the other five sections are not in state and are not invented \u2014 pick up the full card with /inbox in a session.',
		  exportSectionMissing: "(The full text of this section is not in this file: the settings-card state does not provide it. Pick up the full card with /inbox in a session.)",
		  exportHtml: "Export HTML report",
		  exportHtmlTitle: "Build a self-contained single-file HTML report and download it (8-reader support matrix + every pending card + consumed count; zero-dependency, generated in the browser, field-for-field faithful to state)",
		  envelopeArchived: "Machine envelope archived with the card ({n} chars)",
		  coverageBadge: "Coverage {v}",
		  coverageBadgeTitle: "Four-state coverage: share of done-section statements carrying a ledger state (x/y; shown once the host-side data lands)",
		  matrixTitle: "Support matrix (8 readers)",
		  browserTitle: "External session browser",
		  browserHint: 'Browse + one-click takeover: click a reader to list recent local sessions; "Take over" delivers the command to a new session (falls back to copy on failure) \u2014 cards are distilled by the model, so quality follows model capability.',
		  browserPick: "Click a reader above to start (the 8 readers are not scanned automatically)",
		  browserEmpty: "No sessions found for this reader on this machine",
		  browserTotal: "{m} total, showing the {n} most recent",
		  browserNote: "Note: {note}",
		  browserChipAria: "Choose a reader to browse",
		  browserFilterEmpty: "No matching sessions \u2014 clear the filter to restore the full list",
		  browserDisabledTitle: "{label} is disabled or unsupported; browsing unavailable",
		  filterSessionsPlaceholder: "Filter: title / cwd / id\u2026",
		  filterSessionsAria: "Instant session filter (matches title, cwd, or id; clear to restore)",
		  takeoverBtn: "Take over",
		  takeoverTitle: "Delivers the command to a new session (falls back to copy on failure)",
		  depositBtn: "Take over + deposit",
		  depositTitle: "Delivers the two-line command: the card is deposited after takeover (falls back to copy on failure)",
		  deliveringBtn: "Delivering\u2026",
		  deliveredBtn: "Delivered \u2713",
		  fallbackCopyBtn: "Copied (fallback)",
		  fallbackNotice: "Delivery failed ({reason}); fell back to copying the command",
		  copiedBtn: "Copied \u2713",
		  copyIdTitle: "Click to copy the full session id",
		  previewTurns: "{n} turns ({u} user)",
		  previewFirst: "First user request",
		  previewTail: "Recent progress",
		  previewStop: "Stopped at",
		  previewLoadFail: "Preview failed",
		  deliveredNotice: 'Created session "{title}" and delivered the prompt \u2014 click it in the session tree to watch the takeover',
		  inboxTakeBtn: "Take in new session",
		  inboxTakeTitle: "Creates a new session and delivers /inbox (consumed once)",
		  chainBadge: "\u2190 supersedes {id}",
		  chainBadgeTitle: "This card supersedes {id} (relay chain)",
		  chainFilterBtn: "Filter this chain",
		  chainFilterTitle: "Sets the filter to {id} to show cards in this relay chain",
		  subagentBadge: "subagent",
		  subagentGroup: "Subagent sessions ({n})",
		  facetCwdAria: "Filter sessions by project",
		  sessionsCount: "{n} sessions",
		  sessionsProbeFail: "session count probe failed",
		  unsupported: "not supported on this machine",
		  unsupportedNote: "not supported on this machine: {note}",
		  pillOk: "OK",
		  pillNo: "N/A",
		  toggleDisable: 'Disable {label} (foreign_session_read will return "disabled")',
		  toggleEnable: "Enable {label}",
		  toggleAria: "{label} ({id}) reader switch",
		  noteSummary: "\u{1F4A1} Switch semantics",
		  noteBody: 'Disabled providers: foreign_session_read returns the canonical "disabled" error for that vendor. The /resume-* skill guidance is static text; the disabled state is surfaced through the tool error, visible to the model. A greyed row with 0 sessions means the vendor is not installed locally (or has no sessions yet) \u2014 the switch stays but there is nothing to read.',
		  loading: "Loading\u2026",
		  noTime: "(no time)",
		  renderErrorTitle: "dsh-takeover render error (paste the trace below to the maintainer)",
		  reportTitle: "dsh-takeover Handoff Report",
		  reportSubtitle: "Session takeover inbox snapshot (8 readers \xB7 pending cards \xB7 consumed count)",
		  reportGenerated: "Generated at {n}",
		  reportNote: 'Exported by the dsh-takeover settings card as a self-contained single-file HTML. Contains only what /dsh-takeover/state returns right now: pending cards (id / source / title / project / push time and the "goal" section preview), the 8-reader support matrix and the consumed count. The other five card sections, the source session and git snapshots are not in state and are not invented \u2014 pick up full cards with /inbox in a session.',
		  reportStatPending: "Pending",
		  reportStatArchived: "Consumed",
		  reportStatProviders: "Readers (enabled/total)",
		  reportPendingEmpty: "Inbox is empty \u2014 no pending cards right now.",
		  reportSkipped: "{n} unparseable cards were skipped (not listed below)",
		  reportLabelFrom: "Source",
		  reportLabelProject: "Project",
		  reportLabelTime: "Pushed at",
		  reportLabelPreview: "Goal preview",
		  reportDisabled: "disabled"
		};
		var DICTS = { zh, en };
		function interpolate(template, params) {
		  if (params === void 0) return template;
		  return template.replace(/\{(\w+)\}/g, (raw, key) => {
		    const v = params[key];
		    return v === void 0 ? raw : String(v);
		  });
		}
		
		// src/inbox-view.ts
		function filterPending(rows, query, labelOf, source, newOnlyIds) {
		  let out = rows;
		  if (source) out = out.filter((p) => p.agent === source);
		  if (newOnlyIds) out = out.filter((p) => newOnlyIds.has(p.id));
		  const q = query.trim().toLowerCase();
		  if (q === "") return out;
		  return out.filter((p) => {
		    const title = typeof p.title === "string" ? p.title : "";
		    const id = typeof p.id === "string" ? p.id : "";
		    const agent = typeof p.agent === "string" ? p.agent : "";
		    const supersedes = typeof p.supersedes === "string" ? p.supersedes.toLowerCase() : "";
		    return title.toLowerCase().includes(q) || id.toLowerCase().includes(q) || agent.toLowerCase().includes(q) || supersedes.includes(q) || labelOf(p.agent ?? "").toLowerCase().includes(q);
		  });
		}
		function sourceFacets(rows) {
		  const counts = /* @__PURE__ */ new Map();
		  for (const r of rows) counts.set(r.agent, (counts.get(r.agent) ?? 0) + 1);
		  return [...counts.entries()].map(([agent, count]) => ({ agent, count }));
		}
		function groupAdjacent(rows) {
		  const groups = [];
		  let cur = null;
		  for (const p of rows) {
		    if (cur !== null && p.title !== "" && p.agent === cur.agent && p.title === cur.title) {
		      cur.rows.push(p);
		    } else {
		      cur = { key: `g-${groups.length}-${p.id}`, agent: p.agent, title: p.title, rows: [p] };
		      groups.push(cur);
		    }
		  }
		  return groups;
		}
		function fnv1a(text) {
		  let h = 2166136261;
		  for (let i = 0; i < text.length; i++) {
		    h ^= text.charCodeAt(i);
		    h = Math.imul(h, 16777619);
		  }
		  return (h >>> 0).toString(16).padStart(8, "0");
		}
		function seenStorageKey(home) {
		  return `dsh-takeover.seen.v1.${fnv1a(home)}`;
		}
		var SEEN_CAP = 1e3;
		function loadSeenSet(store, key) {
		  if (store === null) return /* @__PURE__ */ new Set();
		  try {
		    const raw = store.getItem(key);
		    if (raw === null) return /* @__PURE__ */ new Set();
		    const parsed = JSON.parse(raw);
		    if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
		    return new Set(parsed.filter((x) => typeof x === "string"));
		  } catch {
		    return /* @__PURE__ */ new Set();
		  }
		}
		function saveSeenSet(store, key, ids) {
		  if (store === null) return;
		  try {
		    const list = [...ids];
		    store.setItem(key, JSON.stringify(list.length > SEEN_CAP ? list.slice(list.length - SEEN_CAP) : list));
		  } catch {
		  }
		}
		function newIdsOf(rows, seen) {
		  return rows.filter((p) => !seen.has(p.id)).map((p) => p.id);
		}
		var SECTION_HEADINGS = [
		  ["goal", "\u76EE\u6807"],
		  ["files", "\u6D89\u53CA\u6587\u4EF6"],
		  ["done", "\u505A\u5230\u54EA"],
		  ["remaining", "\u8FD8\u5DEE\u4EC0\u4E48"],
		  ["stopped", "\u505C\u5728\u54EA"],
		  ["warnings", "\u8BFB\u8005\u8B66\u544A"]
		];
		function yamlQuote(value) {
		  const stripped = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r]/g, "");
		  const escaped = stripped.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		  return `"${escaped}"`;
		}
		function cardMarkdown(p, notes) {
		  const lines = [
		    "---",
		    "handoff: 1",
		    `id: ${yamlQuote(p.id)}`,
		    "from:",
		    `  agent: ${yamlQuote(p.agent)}`,
		    `  title: ${yamlQuote(p.title)}`,
		    `project: ${yamlQuote(p.project)}`,
		    `pushed_at: ${yamlQuote(p.pushedAt)}`,
		    "---",
		    "",
		    notes.top,
		    ""
		  ];
		  for (const [key, heading] of SECTION_HEADINGS) {
		    let body = notes.missing;
		    if (key === "goal" && !p.previewFromDone && p.preview !== "") body = p.preview;
		    if (key === "done" && p.previewFromDone && p.preview !== "") body = p.preview;
		    lines.push(`## ${heading}`, "", body, "");
		  }
		  return lines.join("\n");
		}
		function pendingListMarkdown(rows, notes) {
		  if (rows.length === 0) return "";
		  return rows.map((p) => cardMarkdown(p, notes).trimEnd()).join("\n\n---\n\n") + "\n";
		}
		
		// src/browser-view.ts
		function filterSessions(rows, query) {
		  const q = query.trim().toLowerCase();
		  if (q === "") return rows;
		  return rows.filter(
		    (r) => r.title.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)
		  );
		}
		function relTime(ts, nowMs, lang) {
		  if (ts === "") return lang === "en" ? "(no time)" : "\uFF08\u65E0\u65F6\u95F4\uFF09";
		  const ms = new Date(ts).getTime();
		  if (!Number.isFinite(ms)) return ts;
		  const diff = nowMs - ms;
		  if (diff < 0) return lang === "en" ? "just now" : "\u521A\u521A";
		  const min = Math.floor(diff / 6e4);
		  if (min < 1) return lang === "en" ? "just now" : "\u521A\u521A";
		  if (min < 60) return lang === "en" ? `${min}m ago` : `${min}\u5206\u949F\u524D`;
		  const h = Math.floor(min / 60);
		  if (h < 24) return lang === "en" ? `${h}h ago` : `${h}\u5C0F\u65F6\u524D`;
		  const d = Math.floor(h / 24);
		  if (d < 30) return lang === "en" ? `${d}d ago` : `${d}\u5929\u524D`;
		  const dt = new Date(ms);
		  const pad = (n) => String(n).padStart(2, "0");
		  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
		}
		function takeoverCommand(provider, id) {
		  return `/resume-${provider} ${id}`;
		}
		function depositTail(lang) {
		  return lang === "en" ? "When the takeover is done, deposit the six-section handoff card into the shared inbox." : "\u63A5\u7BA1\u5B8C\u6210\u540E\uFF0C\u628A\u516D\u6BB5\u4EA4\u63A5\u5361\u5BC4\u5B58\u8FDB\u5171\u4EAB\u6536\u4EF6\u7BB1\u3002";
		}
		function depositCommand(provider, id, lang) {
		  return takeoverCommand(provider, id) + "\n" + depositTail(lang);
		}
		function shortId(row) {
		  if (row.kind === "file") {
		    const base = row.id.split(/[\\/]/).pop() ?? row.id;
		    return base !== "" ? base : row.id;
		  }
		  return row.id;
		}
		function isSubagentSession(row) {
		  if (row.id.startsWith("sess_subagent_")) return true;
		  if (/^sess_dwf-/.test(row.id)) return true;
		  return /^workflow subagent/i.test(row.title);
		}
		function cwdFacets(rows) {
		  const freq = /* @__PURE__ */ new Map();
		  for (const r of rows) {
		    const label = r.cwd === "" ? "\u2014" : r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd;
		    const hit = freq.get(r.cwd);
		    if (hit !== void 0) hit.count += 1;
		    else freq.set(r.cwd, { label, count: 1 });
		  }
		  return [...freq.entries()].map(([cwd, v]) => ({ cwd, label: v.label, count: v.count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
		}
		function filterByCwd(rows, cwd) {
		  if (cwd === null) return rows;
		  return rows.filter((r) => r.cwd === cwd);
		}
		
		// src/client.ts
		var tCache = /* @__PURE__ */ new WeakMap();
		function resolveLocale(ctx) {
		  try {
		    const l = ctx.locale;
		    return l !== null && typeof l === "object" ? l : void 0;
		  } catch {
		    return void 0;
		  }
		}
		function makeT(ctx) {
		  const hit = tCache.get(ctx);
		  if (hit !== void 0) return hit;
		  const locale = resolveLocale(ctx);
		  let t;
		  if (locale !== void 0 && typeof locale.register === "function" && typeof locale.bind === "function") {
		    try {
		      locale.register(NS, "zh", DICTS.zh);
		      locale.register(NS, "en", DICTS.en);
		      t = locale.bind(NS);
		    } catch (e) {
		      console.warn("[dsh-takeover] locale register/bind \u5931\u8D25\uFF0C\u56DE\u9000\u9759\u6001\u8BCD\u5178\uFF1A", e);
		      t = (key, params) => interpolate(DICTS.zh[String(key)] ?? String(key), params);
		    }
		  } else {
		    t = (key, params) => interpolate(DICTS.zh[String(key)] ?? String(key), params);
		  }
		  tCache.set(ctx, t);
		  return t;
		}
		function langOf(locale) {
		  try {
		    return locale?.getLocale().active === "en" ? "en" : "zh";
		  } catch {
		    return "zh";
		  }
		}
		function themeVars() {
		  let dark = true;
		  try {
		    let bg = getComputedStyle(document.body).backgroundColor;
		    if (bg === "" || /rgba?\([^)]*\/\s*0\s*\)/.test(bg) || bg === "transparent") {
		      bg = getComputedStyle(document.documentElement).backgroundColor;
		    }
		    const modern = /^(oklch|oklab|lab|lch)\(\s*([\d.]+)(%?)/.exec(bg);
		    if (modern) {
		      const l = Number(modern[2]) * (modern[3] === "%" ? 0.01 : 1);
		      dark = l <= 0.5;
		    } else {
		      const m = bg.match(/\d+/g);
		      if (m && m.length >= 3) {
		        const [r = 0, g = 0, b = 0] = m.map(Number);
		        dark = (0.299 * r + 0.587 * g + 0.114 * b) / 255 <= 0.5;
		      }
		    }
		  } catch {
		  }
		  return dark ? { "--bt-mut": "rgba(255,255,255,.55)", "--bt-ok": "#4ade80", "--bt-warn": "#fbbf24", "--bt-err": "#f87171" } : { "--bt-mut": "rgba(30,41,59,.72)", "--bt-ok": "#15803d", "--bt-warn": "#b45309", "--bt-err": "#d93025" };
		}
		var inject = ["slots", "locale"];
		var ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%" role="img" aria-label="dsh-takeover"><defs><linearGradient id="bt-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366F1"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient><linearGradient id="bt-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".26"/><stop offset=".55" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="15" fill="url(#bt-bg)"/><rect x="2" y="2" width="60" height="60" rx="15" fill="url(#bt-sheen)"/><rect x="2.75" y="2.75" width="58.5" height="58.5" rx="14.25" fill="none" stroke="#ffffff" stroke-opacity=".22" stroke-width="1.5"/><g fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19 L27 32 L15 45"/><path d="M29 19 L41 32 L29 45"/></g><rect x="46.5" y="17" width="6" height="30" rx="3" fill="#ffffff" opacity=".9"/></svg>';
		function providerMark(name) {
		  const m = BRAND_MARKS[name];
		  return m ?? null;
		}
		function ProviderIcon({ name, size = 20 }) {
		  const full = BRAND_FULL_SVG[name];
		  if (full !== void 0) {
		    return (0, import_react.createElement)("span", {
		      className: "bt-icon bt-icon-full",
		      style: { width: size, height: size },
		      title: PROVIDER_LABEL[name] ?? name,
		      dangerouslySetInnerHTML: { __html: full }
		    });
		  }
		  const mark = providerMark(name);
		  if (mark === null) {
		    return (0, import_react.createElement)("span", {
		      className: "bt-icon",
		      style: { background: "linear-gradient(135deg, #6366F1, #8B5CF6)", width: size, height: size },
		      title: PROVIDER_LABEL[name] ?? name,
		      dangerouslySetInnerHTML: { __html: '<svg viewBox="0 0 64 64" width="100%" height="100%"><g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19 L27 32 L15 45"/><path d="M29 19 L41 32 L29 45"/></g></svg>' }
		    });
		  }
		  return (0, import_react.createElement)(
		    "span",
		    {
		      className: "bt-icon",
		      style: { background: mark.tile, width: size, height: size },
		      title: PROVIDER_LABEL[name] ?? name
		    },
		    (0, import_react.createElement)(
		      "svg",
		      { viewBox: mark.viewBox, width: Math.round(size * 0.64), height: Math.round(size * 0.64), "aria-hidden": true },
		      ...mark.paths.map((p, i) => (0, import_react.createElement)("path", { key: i, d: p.d, fill: p.fill }))
		    )
		  );
		}
		var CSS = `
		.bt-panel { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 10px;
		  container-type: inline-size;
		  --bt-a: var(--accent, #6366f1); --bt-ok: #15803d; --bt-warn: #b45309; --bt-err: #d93025;
		  --bt-line: var(--border, rgba(127,127,127,.2)); --bt-mut: rgba(30,41,59,.72);
		  --bt-card: var(--bg, rgba(127,127,127,.05)); --bt-hover: rgba(127,127,127,.07);
		  --bt-shadow: 0 1px 2px rgba(16,24,40,.05), 0 12px 32px -18px rgba(16,24,40,.16); }
		.bt-card { background: var(--bt-card); border: 1px solid var(--bt-line); border-radius: 14px;
		  padding: 16px 18px; display: flex; flex-direction: column; gap: 12px;
		  box-shadow: var(--bt-shadow); }
		.bt-head { display: flex; align-items: center; gap: 12px; }
		.bt-logo { width: 40px; height: 40px; border-radius: 11px; flex: none; overflow: hidden;
		  box-shadow: 0 2px 8px rgba(99,102,241,.35), inset 0 0 0 1px rgba(255,255,255,.18); }
		.bt-logo svg { display: block; }
		.bt-title { font-weight: 700; font-size: 14px; letter-spacing: .01em; }
		.bt-sub { font-size: 12px; color: var(--bt-mut); line-height: 1.55; }
		.bt-spacer { flex: 1; }
		.bt-badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
		  color: var(--bt-mut); background: rgba(127,127,127,.1); border: 1px solid var(--bt-line);
		  font-variant-numeric: tabular-nums; }
		.bt-badge-hot { color: var(--bt-a); background: rgba(99,102,241,.1); border-color: rgba(99,102,241,.3); }
		/* \u6536\u4EF6\u7BB1\u7EDF\u8BA1\u6761\uFF1A\u5F85\u53D6\u4EF6/\u5DF2\u6D88\u8D39/\u8986\u76D6\u7387/\u4FE1\u5C01 \u56DB\u683C\uFF0Clabel+\u6570\u5B57\u540C chip */
		.bt-statstrip { display: flex; gap: 6px; flex-wrap: wrap; }
		.bt-stat { font-size: 11px; color: var(--bt-mut); background: rgba(127,127,127,.08);
		  border: 1px solid var(--bt-line); border-radius: 999px; padding: 2px 10px;
		  font-variant-numeric: tabular-nums; }
		.bt-stat-hot { color: var(--bt-a); background: rgba(99,102,241,.1); border-color: rgba(99,102,241,.3); }
		.bt-stat-warn { color: var(--bt-warn); background: rgba(251,191,36,.12); border-color: rgba(251,191,36,.4); }
		.bt-btn { cursor: pointer; border-radius: 10px; font-size: 12.5px; font-weight: 500; padding: 6px 16px;
		  border: 1px solid var(--bt-line); background: transparent; color: inherit; white-space: nowrap;
		  transition: border-color .15s ease, color .15s ease, background .15s ease, transform .12s ease; }
		.bt-btn:disabled { opacity: .5; cursor: default; }
		.bt-btn:not(:disabled):hover { border-color: var(--bt-a); color: var(--bt-a); transform: translateY(-1px); }
		.bt-btn:not(:disabled):active { transform: translateY(0); }
		.bt-btn-danger:not(:disabled):hover { border-color: var(--bt-err); color: var(--bt-err); }
		.bt-btn-confirm { background: var(--bt-err); border-color: transparent; color: #fff; }
		.bt-btn-confirm:not(:disabled):hover { color: #fff; transform: none; }
		.bt-banner { font-size: 12px; line-height: 1.6; border-radius: 10px; padding: 8px 12px; }
		.bt-banner-info { color: var(--bt-mut); background: rgba(127,127,127,.08); }
		.bt-banner-err { color: var(--bt-err); background: rgba(211,47,47,.08); }
		.bt-rows { display: flex; flex-direction: column; gap: 2px; }
		.bt-pending { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: flex-start;
		  border-radius: 10px; padding: 9px 10px; font-size: 12.5px;
		  cursor: pointer; transition: background .12s ease; }
		.bt-pending:hover { background: var(--bt-hover); }
		.bt-pending:focus-visible { outline: 2px solid var(--bt-a); outline-offset: -2px; }
		.bt-pending-open { background: var(--bt-hover); }
		.bt-pend-icon { flex: none; margin-top: 2px; }
		.bt-pend-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
		.bt-pend-line1 { display: flex; align-items: baseline; gap: 8px; }
		.bt-pending-title { flex: 1; min-width: 0; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.bt-pend-time { flex: none; font-size: 11px; color: var(--bt-mut); font-variant-numeric: tabular-nums; }
		.bt-pending-chev { flex: none; font-size: 10px; color: var(--bt-mut); align-self: center; transition: transform .15s ease; }
		.bt-pending-open .bt-pending-chev { transform: rotate(90deg); }
		.bt-pend-meta { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: var(--bt-mut);
		  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
		.bt-pend-src { font-weight: 500; }
		.bt-pend-dot { opacity: .45; }
		.bt-pend-id { font-family: ui-monospace, monospace; font-size: 10.5px; opacity: .68; }
		.bt-preview { flex-basis: 100%; font-size: 12px; line-height: 1.65; color: inherit;
		  background: var(--bt-card); border-left: 2px solid var(--bt-a); border-radius: 0 10px 10px 0;
		  padding: 8px 12px; margin: 4px 0 2px 0; white-space: pre-wrap;
		  word-break: break-word; display: flex; flex-direction: column; gap: 4px; }
		.bt-preview-hint { font-size: 10.5px; color: var(--bt-mut); }
		/* \u5C55\u5F00\u6001\u52A8\u4F5C\u884C\uFF1A\u9884\u89C8\u63D0\u793A + \u5355\u5361\u5BFC\u51FA\u6309\u94AE */
		.bt-preview-actions { display: flex; align-items: center; gap: 8px; justify-content: space-between;
		  white-space: normal; }
		/* \u6536\u4EF6\u7BB1\u5DE5\u5177\u884C\uFF1A\u5373\u65F6\u8FC7\u6EE4\u8F93\u5165 + \u5BFC\u51FA\u5168\u90E8\uFF08\u8FC7\u6EE4\u8BCD\u7A7A = \u5168\u91CF\uFF09 */
		.bt-inbox-toolbar { display: flex; gap: 8px; align-items: center; margin-top: -2px; }
		.bt-filter { flex: 1; min-width: 0; height: 32px; box-sizing: border-box;
		  border: 1px solid var(--bt-line); border-radius: 10px; background: var(--bt-card);
		  color: inherit; font-size: 12.5px; padding: 0 10px; outline: none;
		  transition: border-color .15s ease, box-shadow .15s ease; }
		.bt-filter:focus { border-color: var(--bt-a); box-shadow: 0 0 0 3px rgba(99,102,241,.15); }
		.bt-filter::placeholder { color: var(--bt-mut); opacity: .75; }
		/* \u884C\u5185\u5C0F\u5FBD\u6807\uFF1A\u300C\u65B0\u300D\uFF08\u672A\u5C55\u5F00\u8FC7\u7684\u5361\uFF09\u4E0E\u5206\u7EC4\u8BA1\u6570\uFF0C\u540C\u4E00\u57FA\u5EA7 */
		.bt-tag { font-size: 10px; font-weight: 700; line-height: 1.5; padding: 1px 8px;
		  border-radius: 999px; flex: none; white-space: nowrap; box-sizing: border-box; letter-spacing: .02em; }
		.bt-tag-new { color: var(--bt-warn); background: rgba(251,191,36,.16); border: 1px solid rgba(251,191,36,.4); }
		.bt-tag-lowinfo { color: var(--bt-mut); background: rgba(127,127,127,.12); border: 1px solid var(--bt-line); }
		.bt-tag-group { color: var(--bt-a); background: rgba(99,102,241,.12); border: 1px solid transparent; }
		/* \u7EC4\u5185\u6210\u5458\u884C\uFF1A\u6574\u4F53\u53F3\u7F29\u8FDB\uFF0C\u89C6\u89C9\u4E0A\u6302\u5728\u7EC4\u5934\u4E0B */
		.bt-pending-member { margin-left: 20px; }
		/* \u884C\u5916\u58F3\uFF08\u4E2D\u6027\u5BB9\u5668\uFF0C\u5185\u542B role=button \u884C + \u5144\u5F1F\u9884\u89C8\u5757\uFF09\uFF1A\u5EF6\u7EED\u539F\u5148\u884C\u5185 flex-wrap \u5E03\u5C40 */
		.bt-pending-wrap { display: flex; flex-wrap: wrap; }
		.bt-cmds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
		.bt-cmd { display: flex; align-items: center; gap: 8px; min-width: 0; border: 1px solid var(--bt-line);
		  border-radius: 10px; padding: 7px 12px; font-size: 12px; background: transparent;
		  transition: opacity .15s ease, border-color .15s ease, background .15s ease; }
		.bt-cmd:hover { border-color: var(--bt-line); background: var(--bt-hover); }
		.bt-cmd-key { font-family: ui-monospace, monospace; font-size: 11.5px; font-weight: 600; flex: none; }
		.bt-cmd-key-primary { color: var(--bt-a); }
		.bt-cmd-desc { color: var(--bt-mut); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.bt-cmd .bt-icon { width: 16px; height: 16px; flex: none; border-radius: 5px; }
		.bt-cmd-off { opacity: .42; }
		.bt-icon { display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
		  flex: none; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255,255,255,.14), 0 1px 2px rgba(0,0,0,.16); }
		.bt-icon svg { display: block; }
		.bt-icon-full { border-radius: 50%; }
		.bt-icon-full svg { width: 100%; height: 100%; }
		.bt-icon-letter { color: #fff; font-weight: 700; font-size: 11px; line-height: 1; letter-spacing: -.02em; user-select: none; }
		.bt-matrix { display: flex; flex-direction: column; }
		.bt-mrow { display: grid; grid-template-columns: minmax(170px, auto) 1fr auto auto; gap: 10px; align-items: center;
		  padding: 8px 6px; font-size: 12.5px; border-bottom: 1px solid var(--bt-line); border-radius: 8px;
		  transition: opacity .15s ease, background .15s ease; }
		.bt-mrow:hover { background: var(--bt-hover); }
		.bt-mrow:last-child { border-bottom: none; }
		.bt-mrow-idle { opacity: .48; }
		.bt-mrow-idle:hover { opacity: .8; }
		.bt-mname-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
		.bt-mname-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
		.bt-mname { font-weight: 600; font-size: 12.5px; white-space: nowrap; }
		.bt-mid { font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--bt-mut); opacity: .75; }
		/* \u5047 0 \u54E8\u5175\u6D6E\u51FA\uFF1Asupported \u4E14 note \u975E\u7A7A\u65F6\u884C\u5185\u6A59\u8272\u5C0F\u5B57\uFF08\u4E0D\u53EA\u653E title\uFF09\uFF0C\u4E0E --bt-warn \u540C\u8F74 */
		.bt-mnote { font-size: 10.5px; line-height: 1.5; color: var(--bt-warn); max-width: 360px; overflow-wrap: anywhere; }
		.bt-mstat { font-size: 11.5px; color: var(--bt-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
		.bt-pill { font-size: 10.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px; flex: none;
		  min-width: 34px; text-align: center; box-sizing: border-box; letter-spacing: .02em; }
		.bt-pill-ok { color: var(--bt-ok); background: rgba(21,128,61,.1); border: 1px solid rgba(21,128,61,.35); }
		.bt-pill-no { color: var(--bt-warn); background: rgba(180,83,9,.1); border: 1px solid rgba(180,83,9,.35); }
		.bt-toggle { cursor: pointer; width: 38px; height: 22px; border-radius: 999px; border: none;
		  background: rgba(127,127,127,.25); position: relative; padding: 0; justify-self: end;
		  transition: background .18s cubic-bezier(.4,0,.2,1); box-shadow: inset 0 1px 2px rgba(0,0,0,.12); }
		.bt-toggle:disabled { opacity: .45; cursor: default; }
		.bt-toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
		  border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: left .18s cubic-bezier(.4,0,.2,1); }
		.bt-toggle-on { background: linear-gradient(135deg, #6366F1, #8B5CF6); }
		.bt-toggle-on::after { left: 19px; }
		.bt-note { font-size: 11.5px; color: var(--bt-mut); line-height: 1.6; border-left: 2px solid var(--bt-line);
		  padding-left: 10px; }
		.bt-note summary { cursor: pointer; user-select: none; list-style: none; display: flex; align-items: center; gap: 6px; }
		.bt-note summary::-webkit-details-marker { display: none; }
		.bt-note summary::before { content: '\u25B8'; font-size: 10px; transition: transform .15s ease; }
		.bt-note[open] summary::before { transform: rotate(90deg); }
		.bt-note-body { margin-top: 6px; }
		/* \u7A84\u5BB9\u5668\uFF08\u4FA7\u680F\u6536\u7A84\uFF09\uFF1A\u547D\u4EE4\u5355\u5217\u3001\u77E9\u9635\u884C\u6536\u6389\u4F1A\u8BDD\u6570\u5217\uFF0C\u907F\u514D\u6324\u538B\u6362\u884C */
		/* \u6765\u6E90\u7B5B\u9009 chips\uFF1A\u5168\u90E8/\u5404\u5BB6/\u53EA\u770B\u65B0\u5361\uFF0Cpill \u57FA\u5EA7 + \u9009\u4E2D\u6001\u54C1\u724C\u63CF\u8FB9 */
		.bt-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 8px; }
		.bt-chip { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
		  border: 1px solid var(--bt-line); border-radius: 999px; padding: 3px 12px;
		  background: transparent; color: var(--bt-mut); font-size: 11.5px; font-weight: 500;
		  font-variant-numeric: tabular-nums;
		  transition: border-color .15s ease, color .15s ease, background .15s ease; }
		.bt-chip:hover { border-color: var(--bt-a); color: var(--bt-a); }
		.bt-chip-on { color: var(--bt-a); background: rgba(99,102,241,.12);
		  border-color: rgba(99,102,241,.45); font-weight: 600; }
		.bt-chip-count { font-size: 10px; opacity: .75; }
		/* \u5916\u90E8\u4F1A\u8BDD\u6D4F\u89C8\u5668\uFF1A\u884C + \u9884\u89C8\u5C55\u5F00\u4F53\u3002\u63A5\u7BA1/\u5BC4\u5B58\u4E00\u952E\u6295\u9012\uFF08FR-1\uFF09\u2014\u2014\u9762\u677F\u4E0D\u4EA7\u5361\uFF0C
		 * \u84B8\u998F\u90FD\u5728\u4F1A\u8BDD\u91CC\u7531\u6A21\u578B\u5B8C\u6210\uFF08\u5361\u7247\u8D28\u91CF\u8DDF\u6A21\u578B\u80FD\u529B\u8D70\uFF09\u3002
		 * \u6837\u5F0F\uFF08\u5BA1\u67E5 Y1-Y3\uFF09\uFF1A\u4E3B\u64CD\u4F5C\u300C\u63A5\u7BA1\u300D\u6709\u4E3B\u6309\u94AE\u6743\u91CD\uFF1B\u52A8\u4F5C\u6309\u94AE\u5B9A\u5BBD\u9632\u72B6\u6001\u6587\u6848\u5207\u6362\u8DF3\u52A8\uFF1B
		 * chips \u4E0E\u6309\u94AE\u8865\u952E\u76D8\u7126\u70B9\u73AF\u3002 */
		.bt-btn-primary { color: var(--bt-a); border-color: rgba(99,102,241,.45); background: rgba(99,102,241,.12); font-weight: 600; }
		.bt-btn-primary:not(:disabled):hover { background: var(--bt-a); border-color: var(--bt-a); color: #fff; transform: translateY(-1px); }
		.bt-fsess-act .bt-btn-xs { min-width: 5.5em; }
		.bt-chip:focus-visible, .bt-btn:focus-visible { outline: 2px solid var(--bt-a); outline-offset: 2px; }
		.bt-chip-off { opacity: .4; }
		.bt-chip-off:hover { border-color: var(--bt-line); color: var(--bt-mut); }
		.bt-btn-xs { font-size: 11px; padding: 2px 8px; border-radius: 8px; }
		.bt-fsess { border: 1px solid var(--bt-line); border-radius: 10px; padding: 7px 10px; margin-bottom: 6px; background: var(--bt-card); }
		.bt-fsess-line1 { display: flex; gap: 8px; align-items: baseline; }
		.bt-fsess-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; overflow: hidden;
		  text-overflow: ellipsis; white-space: nowrap; cursor: pointer; border-radius: 4px; }
		.bt-fsess-title:hover { color: var(--bt-a); }
		.bt-fsess-title:focus-visible { outline: 2px solid var(--bt-a); outline-offset: 2px; }
		.bt-fsess-time { flex: none; font-size: 11px; color: var(--bt-mut); font-variant-numeric: tabular-nums; }
		.bt-fsess-line2 { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
		.bt-fsess-src { flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		  font-size: 11px; color: var(--bt-mut); }
		.bt-fsess-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		  font-size: 11px; color: var(--bt-mut); cursor: pointer; font-variant-numeric: tabular-nums; }
		.bt-fsess-id:hover { color: var(--bt-a); }
		.bt-fsess-id:focus-visible { outline: 2px solid var(--bt-a); outline-offset: 2px; }
		.bt-fsess-act { flex: none; display: flex; gap: 4px; }
		.bt-fsprev { margin-top: 7px; padding-top: 7px; border-top: 1px dashed var(--bt-line); display: grid;
		  gap: 3px; font-size: 11.5px; }
		.bt-fsprev-line { display: flex; gap: 6px; min-width: 0; }
		.bt-fsprev-label { flex: none; color: var(--bt-mut); }
		.bt-fsprev-text { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3;
		  -webkit-box-orient: vertical; word-break: break-word; }
		.bt-fsprev-warn { color: var(--bt-warn); }
		.bt-fs-empty { padding: 8px 2px; }
		.bt-fs-count { margin: 8px 0 6px; }
		@container (max-width: 430px) {
		  .bt-fsess-act { flex-wrap: wrap; }
		}
		@container (max-width: 430px) {
		  .bt-cmds { grid-template-columns: 1fr; }
		  .bt-mrow { grid-template-columns: minmax(0, auto) auto auto; }
		  .bt-mstat { display: none; }
		}
		`;
		async function getState() {
		  const res = await fetch("/dsh-takeover/state", { cache: "no-store" });
		  const body = await res.json();
		  if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
		  return body;
		}
		async function post(path, body) {
		  const res = await fetch(path, {
		    method: "POST",
		    headers: { "content-type": "application/json" },
		    body: JSON.stringify(body)
		  });
		  const data = await res.json();
		  if (!res.ok || "error" in data) throw new Error("error" in data ? data.error : `HTTP ${res.status}`);
		  return data;
		}
		async function getJson(url) {
		  const res = await fetch(url, { cache: "no-store" });
		  if (!res.ok) {
		    let msg = `HTTP ${res.status}`;
		    try {
		      const b = await res.json();
		      if (typeof b.error === "string" && b.error !== "") msg = b.error;
		    } catch {
		    }
		    throw new Error(msg);
		  }
		  return await res.json();
		}
		function copyText(text) {
		  const nav = globalThis.navigator;
		  if (nav?.clipboard?.writeText !== void 0) return nav.clipboard.writeText(text);
		  return new Promise((resolve, reject) => {
		    try {
		      const ta = document.createElement("textarea");
		      ta.value = text;
		      ta.style.position = "fixed";
		      ta.style.opacity = "0";
		      document.body.appendChild(ta);
		      ta.select();
		      const ok = document.execCommand("copy");
		      ta.remove();
		      if (ok) resolve();
		      else reject(new Error("execCommand copy failed"));
		    } catch (e) {
		      reject(e);
		    }
		  });
		}
		function fmtTime(iso, lang) {
		  const d = new Date(iso);
		  if (Number.isNaN(d.getTime())) return iso;
		  const pad = (n) => String(n).padStart(2, "0");
		  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
		  const now = /* @__PURE__ */ new Date();
		  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
		  if (sameDay) return hm;
		  return lang === "en" ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : `${d.getMonth() + 1}\u6708${d.getDate()}\u65E5 ${hm}`;
		}
		function safeLocalStorage() {
		  try {
		    const s = globalThis.localStorage;
		    if (s === null || typeof s !== "object") return null;
		    const store = s;
		    const probe = "__dsh_takeover_probe__";
		    store.setItem(probe, probe);
		    store.removeItem(probe);
		    return store;
		  } catch {
		    return null;
		  }
		}
		function downloadText(filename, text, mime = "text/markdown;charset=utf-8") {
		  const blob = new Blob([text], { type: mime });
		  const url = URL.createObjectURL(blob);
		  const a = document.createElement("a");
		  a.href = url;
		  a.download = filename;
		  document.body.appendChild(a);
		  a.click();
		  a.remove();
		  window.setTimeout(() => {
		    URL.revokeObjectURL(url);
		  }, 1e3);
		}
		function exportStamp(d = /* @__PURE__ */ new Date()) {
		  const pad = (n) => String(n).padStart(2, "0");
		  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
		}
		function isCount(v) {
		  return typeof v === "number" && Number.isFinite(v) && v >= 0;
		}
		function extrasOf(state) {
		  const v = state.extras;
		  return v !== null && typeof v === "object" ? v : {};
		}
		function envelopeCharsOf(state) {
		  const top = state;
		  const extra = extrasOf(state);
		  for (const c of [extra.envelopeChars, top.envelopeChars]) {
		    if (isCount(c)) return c;
		  }
		  for (const env of [extra.envelope, top.envelope]) {
		    if (env !== null && typeof env === "object") {
		      const chars = env.chars;
		      if (isCount(chars)) return chars;
		    }
		  }
		  return null;
		}
		function coverageTextOf(state) {
		  const top = state;
		  const extra = extrasOf(state);
		  for (const c of [extra.coverage, top.coverage]) {
		    if (typeof c === "string") {
		      const s = c.trim();
		      if (s !== "") return s;
		    } else if (c !== null && typeof c === "object") {
		      const o = c;
		      if (isCount(o.statements) && isCount(o.marked) && isCount(o.unmarked)) {
		        return `${o.marked}/${o.statements}`;
		      }
		      const x = isCount(o.done) ? o.done : isCount(o.x) ? o.x : null;
		      const y = isCount(o.total) ? o.total : isCount(o.y) ? o.y : null;
		      if (x !== null && y !== null) return `${x}/${y}`;
		    }
		  }
		  return null;
		}
		function escHtml(v) {
		  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
		}
		function absTime(iso) {
		  const d = new Date(iso);
		  if (Number.isNaN(d.getTime())) return iso;
		  const pad = (n) => String(n).padStart(2, "0");
		  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}
		function reportWords(lang) {
		  const d = DICTS[lang];
		  const w = (key) => d[key] ?? key;
		  return {
		    title: w("reportTitle"),
		    subtitle: w("reportSubtitle"),
		    generated: w("reportGenerated"),
		    note: w("reportNote"),
		    statPending: w("reportStatPending"),
		    statArchived: w("reportStatArchived"),
		    statProviders: w("reportStatProviders"),
		    sectionInbox: w("inboxTitle"),
		    sectionMatrix: w("matrixTitle"),
		    pendingEmpty: w("reportPendingEmpty"),
		    skipped: w("reportSkipped"),
		    labelFrom: w("reportLabelFrom"),
		    labelProject: w("reportLabelProject"),
		    labelTime: w("reportLabelTime"),
		    labelPreview: w("reportLabelPreview"),
		    previewEmpty: w("previewEmpty"),
		    sessionsCount: w("sessionsCount"),
		    sessionsProbeFail: w("sessionsProbeFail"),
		    unsupported: w("unsupported"),
		    unsupportedNote: w("unsupportedNote"),
		    pillOk: w("pillOk"),
		    pillNo: w("pillNo"),
		    disabled: w("reportDisabled"),
		    unknownSource: w("unknownSource")
		  };
		}
		var REPORT_CSS = `
		:root { color-scheme: light; }
		* { box-sizing: border-box; }
		body { margin: 0; background: #f4f5fb; color: #1e293b;
		  font: 14px/1.65 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
		.rt-hero { background: linear-gradient(135deg, #6366F1, #8B5CF6); color: #fff; padding: 34px 28px 28px; }
		.rt-hero h1 { margin: 0; font-size: 22px; letter-spacing: .01em; overflow-wrap: anywhere; }
		.rt-sub { margin: 6px 0 0; font-size: 13.5px; opacity: .85; }
		.rt-meta { margin: 14px 0 0; font-size: 12px; opacity: .78; }
		.rt-main { max-width: 860px; margin: 0 auto; padding: 22px 20px 8px; display: flex; flex-direction: column; gap: 16px; }
		.rt-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
		.rt-stat { background: #fff; border: 1px solid rgba(99,102,241,.18); border-radius: 12px; padding: 14px 16px;
		  display: flex; flex-direction: column; gap: 2px; box-shadow: 0 1px 2px rgba(30,41,59,.06); }
		.rt-stat-n { font-size: 24px; font-weight: 700; color: #4f46e5; }
		.rt-stat-label { font-size: 12px; color: #64748b; }
		.rt-note { margin: 0; font-size: 12px; line-height: 1.7; color: #64748b; background: rgba(99,102,241,.06);
		  border: 1px solid rgba(99,102,241,.16); border-radius: 10px; padding: 10px 14px; }
		.rt-card { background: #fff; border: 1px solid rgba(30,41,59,.08); border-radius: 12px; padding: 16px 18px; }
		.rt-card h2 { margin: 0 0 12px; font-size: 15px; color: #312e81; }
		.rt-empty { color: #64748b; font-size: 13px; background: rgba(127,127,127,.07); border-radius: 8px; padding: 12px 14px; }
		.rt-warn { color: #b45309; font-size: 12.5px; line-height: 1.6; background: rgba(251,191,36,.13);
		  border-radius: 8px; padding: 10px 14px; margin: 0 0 10px; overflow-wrap: anywhere; }
		.rt-pcard { border: 1px solid rgba(30,41,59,.08); border-radius: 10px; padding: 12px 14px; }
		.rt-pcard + .rt-pcard { margin-top: 10px; }
		.rt-ptitle { margin: 0 0 4px; font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
		.rt-pid { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px;
		  font-weight: 500; color: #6366F1; background: rgba(99,102,241,.08); border-radius: 6px; padding: 1px 7px; margin-left: 6px; }
		.rt-pmeta { margin: 0 0 8px; font-size: 12px; color: #64748b; display: flex; flex-wrap: wrap; gap: 2px 14px; }
		.rt-plabel { font-size: 11px; opacity: .82; margin-right: 3px; }
		.rt-preview { margin-top: 2px; padding: 8px 12px; border-left: 3px solid #6366F1; background: #f8f9ff;
		  border-radius: 0 8px 8px 0; }
		.rt-preview-body { font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
		.rt-mrow { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 7px 2px;
		  border-bottom: 1px dashed rgba(30,41,59,.1); font-size: 13px; }
		.rt-mrow:last-child { border-bottom: none; }
		.rt-mrow-off { opacity: .55; }
		.rt-mname { font-weight: 600; min-width: 140px; }
		.rt-mid { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: #94a3b8; }
		.rt-pill { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 1px 10px; white-space: nowrap; }
		.rt-pill-ok { color: #15803d; background: rgba(21,128,61,.1); border: 1px solid rgba(21,128,61,.35); }
		.rt-pill-no { color: #b45309; background: rgba(180,83,9,.1); border: 1px solid rgba(180,83,9,.35); }
		.rt-mstat { color: #64748b; font-size: 12px; }
		.rt-mnote { flex-basis: 100%; color: #b45309; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
		.rt-foot { text-align: center; color: #94a3b8; font-size: 11.5px; padding: 14px 0 30px; }
		@media (max-width: 560px) { .rt-stats { grid-template-columns: 1fr; } }
		`;
		function buildReportHtml(state, words, lang, generatedAt) {
		  const esc = escHtml;
		  const enabled = state.providers.filter((p) => p.enabled).length;
		  const statCards = `<div class="rt-stat"><span class="rt-stat-n">${state.pending.length}</span><span class="rt-stat-label">${esc(words.statPending)}</span></div><div class="rt-stat"><span class="rt-stat-n">${state.archivedCount}</span><span class="rt-stat-label">${esc(words.statArchived)}</span></div><div class="rt-stat"><span class="rt-stat-n">${enabled}/${state.providers.length}</span><span class="rt-stat-label">${esc(words.statProviders)}</span></div>`;
		  const inboxFlags = (state.inboxError !== void 0 && state.inboxError !== "" ? `<div class="rt-warn">${esc(state.inboxError)}</div>` : "") + (state.pendingSkipped > 0 ? `<div class="rt-warn">${esc(interpolate(words.skipped, { n: state.pendingSkipped }))}</div>` : "");
		  const pendingCards = state.pending.map((p) => {
		    const hasTitle = p.title !== "";
		    const title = hasTitle ? p.title : p.id;
		    const idChip = hasTitle ? `<span class="rt-pid">${esc(p.id)}</span>` : "";
		    const project = p.project !== "" ? `<span><span class="rt-plabel">${esc(words.labelProject)}</span>${esc(p.project)}</span>` : "";
		    const previewBody = p.preview !== "" ? p.preview : words.previewEmpty;
		    return `<div class="rt-pcard"><p class="rt-ptitle">${esc(title)}${idChip}</p><p class="rt-pmeta"><span><span class="rt-plabel">${esc(words.labelFrom)}</span>${esc(PROVIDER_LABEL[p.agent] ?? (p.agent === "" ? words.unknownSource : p.agent))}</span>` + project + `<span><span class="rt-plabel">${esc(words.labelTime)}</span>${esc(absTime(p.pushedAt))}</span></p><div class="rt-preview"><span class="rt-plabel">${esc(words.labelPreview)}</span><div class="rt-preview-body">${esc(previewBody)}</div></div></div>`;
		  }).join("");
		  const inboxBody = state.pending.length === 0 ? `<div class="rt-empty">${esc(words.pendingEmpty)}</div>` : pendingCards;
		  const matrixRows = state.providers.map((r) => {
		    const label = PROVIDER_LABEL[r.name] ?? r.name;
		    const stat = r.supported ? r.sessions >= 0 ? interpolate(words.sessionsCount, { n: r.sessions }) : words.sessionsProbeFail : r.note !== "" ? interpolate(words.unsupportedNote, { note: r.note }) : words.unsupported;
		    const note = r.supported && r.note !== "" ? `<span class="rt-mnote">${esc(r.note)}</span>` : "";
		    return `<div class="rt-mrow${r.enabled ? "" : " rt-mrow-off"}"><span class="rt-mname">${esc(label)}</span><span class="rt-mid">${esc(r.name)}</span><span class="rt-pill ${r.supported ? "rt-pill-ok" : "rt-pill-no"}">${esc(r.supported ? words.pillOk : words.pillNo)}</span><span class="rt-mstat">${esc(stat)}${r.enabled ? "" : ` \xB7 ${esc(words.disabled)}`}</span>` + note + `</div>`;
		  }).join("");
		  return `<!DOCTYPE html>
		<html lang="${lang}">
		<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>${esc(words.title)} \xB7 ${esc(generatedAt)}</title>
		<style>${REPORT_CSS}</style>
		</head>
		<body>
		<header class="rt-hero">
		<h1>${esc(words.title)}</h1>
		<p class="rt-sub">${esc(words.subtitle)}</p>
		<p class="rt-meta">${esc(interpolate(words.generated, { n: generatedAt }))} \xB7 dsh-takeover</p>
		</header>
		<main class="rt-main">
		<div class="rt-stats">${statCards}</div>
		<p class="rt-note">${esc(words.note)}</p>
		<section class="rt-card">
		<h2>${esc(words.sectionInbox)}</h2>
		${inboxFlags}
		${inboxBody}
		</section>
		<section class="rt-card">
		<h2>${esc(words.sectionMatrix)}</h2>
		${matrixRows}
		</section>
		</main>
		<footer class="rt-foot">dsh-takeover \xB7 handoff: 1</footer>
		</body>
		</html>
		`;
		}
		function PendingList({ rows, query, home, t, lang, onExport, onChainFilter, onTakeInbox, takeBusyId }) {
		  const [store] = (0, import_react.useState)(safeLocalStorage);
		  const [seen, setSeen] = (0, import_react.useState)(() => loadSeenSet(store, seenStorageKey(home)));
		  const [openIds, setOpenIds] = (0, import_react.useState)(/* @__PURE__ */ new Set());
		  (0, import_react.useEffect)(() => {
		    setSeen(loadSeenSet(store, seenStorageKey(home)));
		  }, [store, home]);
		  const markSeen = (ids) => {
		    setSeen((prev) => {
		      const fresh = ids.filter((id) => !prev.has(id));
		      if (fresh.length === 0) return prev;
		      const next = new Set(prev);
		      for (const id of fresh) next.add(id);
		      queueMicrotask(() => saveSeenSet(store, seenStorageKey(home), next));
		      return next;
		    });
		  };
		  const toggleOpen = (id) => {
		    setOpenIds((prev) => {
		      const next = new Set(prev);
		      if (next.has(id)) next.delete(id);
		      else next.add(id);
		      return next;
		    });
		    markSeen([id]);
		  };
		  const toggleGroup = (g) => {
		    const willOpen = !openIds.has(g.key);
		    setOpenIds((prev) => {
		      const next = new Set(prev);
		      if (next.has(g.key)) next.delete(g.key);
		      else next.add(g.key);
		      return next;
		    });
		    if (willOpen) markSeen(g.rows.map((r) => r.id));
		  };
		  const [sourceSel, setSourceSel] = (0, import_react.useState)(null);
		  const [newOnly, setNewOnly] = (0, import_react.useState)(false);
		  const newIds = new Set(newIdsOf(rows, seen));
		  const visible = filterPending(
		    rows,
		    query,
		    (a) => PROVIDER_LABEL[a] ?? (a === "" ? t("unknownSource") : a),
		    sourceSel,
		    newOnly ? newIds : null
		  );
		  const lowRows = visible.filter((r) => r.lowInfo === true);
		  const mainRows = visible.filter((r) => r.lowInfo !== true);
		  const groups = groupAdjacent(mainRows);
		  const facets = sourceFacets(rows);
		  const chip = (label, count, on, onClick, key) => (0, import_react.createElement)(
		    "button",
		    {
		      key,
		      className: `bt-chip${on ? " bt-chip-on" : ""}`,
		      "aria-pressed": on,
		      onClick,
		      type: "button"
		    },
		    (0, import_react.createElement)("span", { className: "bt-chip-label" }, label),
		    (0, import_react.createElement)("span", { className: "bt-chip-count" }, String(count))
		  );
		  const agentLabel = (a) => PROVIDER_LABEL[a] ?? (a === "" ? t("unknownSource") : a);
		  const chipBar = (0, import_react.createElement)(
		    "div",
		    { className: "bt-chips", role: "group", "aria-label": t("chipSourceAria") },
		    chip(t("chipAll"), rows.length, sourceSel === null, () => setSourceSel(null), "chip-all"),
		    ...facets.map((f) => chip(
		      agentLabel(f.agent),
		      f.count,
		      sourceSel === f.agent,
		      () => setSourceSel(sourceSel === f.agent ? null : f.agent),
		      "chip-" + f.agent
		    )),
		    chip(t("newOnlyChip"), newIds.size, newOnly, () => setNewOnly(!newOnly), "chip-new")
		  );
		  const lowInfoNode = (low) => {
		    const key = "bt-lowinfo";
		    const open = openIds.has(key);
		    const hasNew = low.some((r) => !seen.has(r.id));
		    const toggle = () => {
		      setOpenIds((prev) => {
		        const nx = new Set(prev);
		        if (nx.has(key)) nx.delete(key);
		        else nx.add(key);
		        return nx;
		      });
		      if (!open) markSeen(low.map((r) => r.id));
		    };
		    return (0, import_react.createElement)(
		      "div",
		      { key, className: "bt-group" },
		      (0, import_react.createElement)(
		        "div",
		        {
		          className: `bt-pending${open ? " bt-pending-open" : ""}`,
		          role: "button",
		          tabIndex: 0,
		          "aria-expanded": open,
		          "aria-label": t("groupAria", { title: t("lowInfoGroup", { n: low.length }), n: low.length }),
		          onClick: toggle,
		          onKeyDown: (e) => {
		            if (e.key === "Enter" || e.key === " ") {
		              e.preventDefault();
		              toggle();
		            }
		          }
		        },
		        (0, import_react.createElement)("span", { className: "bt-tag bt-tag-lowinfo" }, t("lowInfoBadge")),
		        (0, import_react.createElement)("span", { className: "bt-pending-title" }, t("lowInfoGroup", { n: low.length })),
		        hasNew ? (0, import_react.createElement)("span", { className: "bt-tag bt-tag-new" }, t("newBadge")) : null,
		        (0, import_react.createElement)("span", { className: "bt-pending-chev", "aria-hidden": true }, "\u25B8")
		      ),
		      open ? low.map((r) => rowNode(r, true)) : null
		    );
		  };
		  const rowNode = (p, inGroup) => {
		    const open = openIds.has(p.id);
		    const isNew = !seen.has(p.id);
		    return (0, import_react.createElement)(
		      "div",
		      { key: p.id, className: inGroup ? "bt-pending-member" : void 0 },
		      (0, import_react.createElement)(
		        "div",
		        {
		          className: `bt-pending${open ? " bt-pending-open" : ""}`,
		          title: p.id,
		          role: "button",
		          tabIndex: 0,
		          "aria-expanded": open,
		          onClick: () => {
		            toggleOpen(p.id);
		          },
		          onKeyDown: (e) => {
		            if (e.key === "Enter" || e.key === " ") {
		              e.preventDefault();
		              toggleOpen(p.id);
		            }
		          }
		        },
		        (0, import_react.createElement)("span", { className: "bt-pend-icon" }, (0, import_react.createElement)(ProviderIcon, { name: p.agent, size: 22 })),
		        (0, import_react.createElement)(
		          "span",
		          { className: "bt-pend-main" },
		          (0, import_react.createElement)(
		            "span",
		            { className: "bt-pend-line1" },
		            (0, import_react.createElement)("span", { className: "bt-pending-title" }, p.title !== "" ? p.title : p.id),
		            isNew ? (0, import_react.createElement)("span", { className: "bt-tag bt-tag-new" }, t("newBadge")) : null,
		            p.lowInfo === true ? (0, import_react.createElement)("span", { className: "bt-tag bt-tag-lowinfo" }, t("lowInfoBadge")) : null,
		            // FR-4：接力链徽标（展示位；过滤入口在展开态「只看此链」——行内不嵌交互，ARIA 禁则同前）
		            p.supersedes !== void 0 ? (0, import_react.createElement)("span", {
		              className: "bt-tag bt-tag-group",
		              title: t("chainBadgeTitle", { id: p.supersedes })
		            }, t("chainBadge", { id: p.supersedes.length > 16 ? `${p.supersedes.slice(0, 16)}\u2026` : p.supersedes })) : null,
		            (0, import_react.createElement)("span", { className: "bt-pend-time" }, p.pushedAt === "" ? t("noTime") : fmtTime(p.pushedAt, lang))
		          ),
		          (0, import_react.createElement)(
		            "span",
		            {
		              className: "bt-pend-meta",
		              title: `${t("from", { name: "" }).trim()} \xB7 ${t("project", { name: "" }).trim()} \xB7 ${t("idLabel", { id: "" }).trim()}`
		            },
		            (0, import_react.createElement)("span", { className: "bt-pend-src" }, agentLabel(p.agent)),
		            p.project !== "" ? (0, import_react.createElement)("span", { className: "bt-pend-dot" }, "\xB7") : null,
		            p.project !== "" ? (0, import_react.createElement)("span", null, p.project) : null,
		            (0, import_react.createElement)("span", { className: "bt-pend-dot" }, "\xB7"),
		            (0, import_react.createElement)("span", { className: "bt-pend-id" }, p.id)
		          )
		        ),
		        (0, import_react.createElement)("span", { className: "bt-pending-chev", "aria-hidden": true }, "\u25B8")
		      ),
		      open ? (0, import_react.createElement)(
		        "div",
		        { className: "bt-preview", onClick: (e) => e.stopPropagation() },
		        (0, import_react.createElement)("span", null, p.preview !== "" ? p.preview : t("previewEmpty")),
		        (0, import_react.createElement)(
		          "span",
		          { className: "bt-preview-actions" },
		          (0, import_react.createElement)("span", { className: "bt-preview-hint" }, t("previewHint")),
		          p.supersedes !== void 0 ? (0, import_react.createElement)("button", {
		            className: "bt-btn",
		            onClick: () => {
		              setSourceSel(null);
		              setNewOnly(false);
		              onChainFilter(p.supersedes);
		            },
		            title: t("chainFilterTitle", { id: p.supersedes })
		          }, t("chainFilterBtn")) : null,
		          (0, import_react.createElement)("button", {
		            className: "bt-btn",
		            disabled: takeBusyId !== null,
		            onClick: () => {
		              onTakeInbox(p);
		            },
		            title: t("inboxTakeTitle")
		          }, takeBusyId === p.id ? t("deliveringBtn") : t("inboxTakeBtn")),
		          (0, import_react.createElement)("button", {
		            className: "bt-btn",
		            onClick: () => {
		              onExport(p);
		            },
		            title: t("exportCardTitle")
		          }, t("exportCard"))
		        )
		      ) : null
		    );
		  };
		  const groupNode = (g) => {
		    const open = openIds.has(g.key);
		    const hasNew = g.rows.some((r) => !seen.has(r.id));
		    const head = g.rows[0];
		    return (0, import_react.createElement)(
		      "div",
		      { key: g.key, className: "bt-group" },
		      (0, import_react.createElement)(
		        "div",
		        {
		          className: `bt-pending${open ? " bt-pending-open" : ""}`,
		          title: g.rows.map((r) => r.id).join(" \xB7 "),
		          role: "button",
		          tabIndex: 0,
		          "aria-expanded": open,
		          "aria-label": t("groupAria", { title: g.title, n: g.rows.length }),
		          onClick: () => {
		            toggleGroup(g);
		          },
		          onKeyDown: (e) => {
		            if (e.key === "Enter" || e.key === " ") {
		              e.preventDefault();
		              toggleGroup(g);
		            }
		          }
		        },
		        (0, import_react.createElement)("span", { className: "bt-pend-icon" }, (0, import_react.createElement)(ProviderIcon, { name: g.agent, size: 22 })),
		        (0, import_react.createElement)(
		          "span",
		          { className: "bt-pend-main" },
		          (0, import_react.createElement)(
		            "span",
		            { className: "bt-pend-line1" },
		            (0, import_react.createElement)("span", { className: "bt-pending-title" }, g.title),
		            (0, import_react.createElement)("span", { className: "bt-tag bt-tag-group" }, t("groupCount", { n: g.rows.length })),
		            hasNew ? (0, import_react.createElement)("span", { className: "bt-tag bt-tag-new" }, t("newBadge")) : null,
		            head !== void 0 ? (0, import_react.createElement)("span", { className: "bt-pend-time" }, head.pushedAt === "" ? t("noTime") : fmtTime(head.pushedAt, lang)) : null
		          ),
		          (0, import_react.createElement)(
		            "span",
		            {
		              className: "bt-pend-meta",
		              title: t("from", { name: "" }).trim()
		            },
		            (0, import_react.createElement)("span", { className: "bt-pend-src" }, agentLabel(g.agent))
		          )
		        ),
		        (0, import_react.createElement)("span", { className: "bt-pending-chev", "aria-hidden": true }, "\u25B8")
		      ),
		      open ? g.rows.map((r) => rowNode(r, true)) : null
		    );
		  };
		  return (0, import_react.createElement)(
		    "div",
		    { className: "bt-rows" },
		    chipBar,
		    rows.length === 0 ? (0, import_react.createElement)("div", { className: "bt-banner bt-banner-info" }, t("emptyInbox")) : visible.length === 0 ? (0, import_react.createElement)("div", { className: "bt-banner bt-banner-info" }, t("filterEmpty")) : mainRows.length === 0 && lowRows.length > 0 ? lowInfoNode(lowRows) : [
		      ...groups.map((g) => g.rows.length > 1 ? groupNode(g) : rowNode(g.rows[0], false)),
		      lowRows.length > 0 ? lowInfoNode(lowRows) : null
		    ]
		  );
		}
		function ProviderMatrix({ rows, busy, onToggle, t }) {
		  return (0, import_react.createElement)(
		    "div",
		    { className: "bt-matrix" },
		    ...rows.map((r) => {
		      const label = PROVIDER_LABEL[r.name] ?? r.name;
		      const showNote = r.supported && r.note !== "";
		      const noteId = `bt-mnote-${r.name}`;
		      return (0, import_react.createElement)(
		        "div",
		        {
		          key: r.name,
		          className: `bt-mrow${!r.supported || r.sessions === 0 ? " bt-mrow-idle" : ""}`,
		          title: r.note !== "" ? r.note : void 0,
		          // aria-description 不是有效 ARIA 属性（读屏不识别）——改 aria-describedby 指向可见 note 节点
		          "aria-describedby": showNote ? noteId : void 0
		        },
		        (0, import_react.createElement)(
		          "span",
		          { className: "bt-mname-col" },
		          (0, import_react.createElement)(
		            "span",
		            { className: "bt-mname-wrap" },
		            (0, import_react.createElement)(ProviderIcon, { name: r.name }),
		            (0, import_react.createElement)("span", { className: "bt-mname" }, label),
		            (0, import_react.createElement)("span", { className: "bt-mid" }, r.name)
		          ),
		          showNote ? (0, import_react.createElement)("span", { className: "bt-mnote", id: noteId }, r.note) : null
		        ),
		        (0, import_react.createElement)(
		          "span",
		          { className: "bt-mstat" },
		          r.supported ? r.sessions >= 0 ? t("sessionsCount", { n: r.sessions }) : t("sessionsProbeFail") : r.note !== "" ? t("unsupportedNote", { note: r.note }) : t("unsupported")
		        ),
		        (0, import_react.createElement)(
		          "span",
		          { className: `bt-pill ${r.supported ? "bt-pill-ok" : "bt-pill-no"}` },
		          r.supported ? t("pillOk") : t("pillNo")
		        ),
		        (0, import_react.createElement)("button", {
		          className: `bt-toggle${r.enabled ? " bt-toggle-on" : ""}`,
		          role: "switch",
		          "aria-checked": r.enabled,
		          "aria-label": t("toggleAria", { label, id: r.name }),
		          disabled: busy !== null,
		          title: r.enabled ? t("toggleDisable", { label }) : t("toggleEnable", { label }),
		          onClick: () => {
		            onToggle(r.name, !r.enabled);
		          }
		        })
		      );
		    })
		  );
		}
		function ForeignBrowser({ state, t, lang, onError, onNotice }) {
		  const providers = state?.providers ?? [];
		  const [sel, setSel] = (0, import_react.useState)(null);
		  const [lists, setLists] = (0, import_react.useState)({});
		  const [loading, setLoading] = (0, import_react.useState)({});
		  const [query, setQuery] = (0, import_react.useState)("");
		  const [cwdSel, setCwdSel] = (0, import_react.useState)(null);
		  const [subOpen, setSubOpen] = (0, import_react.useState)(false);
		  const [busyKey, setBusyKey] = (0, import_react.useState)(null);
		  const [deliveredKey, setDeliveredKey] = (0, import_react.useState)(null);
		  const [openId, setOpenId] = (0, import_react.useState)(null);
		  const [previews, setPreviews] = (0, import_react.useState)({});
		  const [copied, setCopied] = (0, import_react.useState)(null);
		  const copyTimer = (0, import_react.useRef)(void 0);
		  const load = (provider2) => {
		    setLoading((prev) => ({ ...prev, [provider2]: true }));
		    void getJson(`/dsh-takeover/sessions?provider=${encodeURIComponent(provider2)}`).then((b) => {
		      if (b.ok !== true) throw new Error(b.error);
		      setLists((prev) => ({ ...prev, [provider2]: b }));
		    }).catch((e) => onError(e instanceof Error ? e.message : String(e))).finally(() => setLoading((cur) => {
		      if (cur[provider2] !== true) return cur;
		      const next = { ...cur };
		      delete next[provider2];
		      return next;
		    }));
		  };
		  const loadPreview = (provider2, id) => {
		    setPreviews((prev) => ({ ...prev, [id]: { loading: true, data: prev[id]?.data ?? null, error: null } }));
		    void getJson(
		      `/dsh-takeover/session-preview?provider=${encodeURIComponent(provider2)}&reference=${encodeURIComponent(id)}`
		    ).then((b) => {
		      if (b.ok !== true) throw new Error(b.error);
		      setPreviews((prev) => ({ ...prev, [id]: { loading: false, data: b, error: null } }));
		    }).catch((e) => {
		      setPreviews((prev) => ({ ...prev, [id]: { loading: false, data: null, error: e instanceof Error ? e.message : String(e) } }));
		    });
		  };
		  const copy = (key, text) => {
		    void copyText(text).then(() => {
		      setCopied(key);
		      window.clearTimeout(copyTimer.current);
		      copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
		    }).catch((e) => onError(e instanceof Error ? e.message : String(e)));
		  };
		  const now = Date.now();
		  const list = sel !== null ? lists[sel] : void 0;
		  const provider = sel ?? "";
		  const clip = (s, n = 260) => s.length > n ? `${s.slice(0, n)}\u2026` : s;
		  const runTakeover = (key, mode, id) => {
		    if (busyKey !== null) return;
		    const fallback = mode === "take_deposit" ? depositCommand(provider, id, lang) : takeoverCommand(provider, id);
		    setBusyKey(key);
		    void post(
		      "/dsh-takeover/takeover",
		      { mode, provider, reference: id, lang }
		    ).then((r) => {
		      if (!r.ok) throw new Error(r.error);
		      setDeliveredKey(key);
		      return void 0;
		    }).catch((e) => {
		      const reason = e instanceof Error ? e.message : String(e);
		      copyText(fallback).then(() => {
		        setCopied(key);
		        window.clearTimeout(copyTimer.current);
		        copyTimer.current = window.setTimeout(() => setCopied(null), 2400);
		        onNotice(t("fallbackNotice", { reason }));
		      }).catch((ce) => onError(ce instanceof Error ? ce.message : String(ce)));
		    }).finally(() => setBusyKey(null));
		  };
		  const line = (label, text, key) => (0, import_react.createElement)(
		    "div",
		    { className: "bt-fsprev-line", key },
		    label !== "" ? (0, import_react.createElement)("span", { className: "bt-fsprev-label" }, label) : null,
		    (0, import_react.createElement)("span", { className: "bt-fsprev-text" }, text)
		  );
		  const previewNode = (id) => {
		    const pv = previews[id];
		    if (pv === void 0 || pv.loading) return (0, import_react.createElement)("div", { className: "bt-fsprev" }, t("loading"));
		    if (pv.error !== null) {
		      return (0, import_react.createElement)("div", { className: "bt-fsprev bt-fsprev-warn" }, `${t("previewLoadFail")}\uFF1A${pv.error}`);
		    }
		    const d = pv.data;
		    if (d === null) return null;
		    const warns = d.skeleton.warnings.split("\n").map((s) => s.trim()).filter((s) => s !== "").slice(0, 3);
		    return (0, import_react.createElement)(
		      "div",
		      { className: "bt-fsprev" },
		      (0, import_react.createElement)(
		        "div",
		        { className: "bt-fsprev-line" },
		        (0, import_react.createElement)(
		          "span",
		          { className: "bt-fsprev-label" },
		          t("previewTurns", { n: d.summary.turnCount, u: d.summary.userTurns })
		        ),
		        d.note !== void 0 ? (0, import_react.createElement)("span", { className: "bt-fsprev-warn" }, d.note) : null
		      ),
		      d.summary.firstUserMessage !== "" ? line(t("previewFirst"), clip(d.summary.firstUserMessage), "pv-first") : null,
		      ...d.summary.tailProgress.slice(0, 2).map((s, i) => line(i === 0 ? t("previewTail") : "", clip(s, 200), `pv-tail-${i}`)),
		      line(t("previewStop"), clip(d.skeleton.stopped), "pv-stop"),
		      ...warns.map((w, i) => (0, import_react.createElement)("div", { className: "bt-fsprev-line bt-fsprev-warn", key: `pv-warn-${i}` }, `\u26A0 ${clip(w, 200)}`))
		    );
		  };
		  const toggleRow = (r, open) => {
		    setOpenId(open ? null : r.id);
		    if (!open && previews[r.id] === void 0 && sel !== null) loadPreview(sel, r.id);
		  };
		  const rowNode = (r) => {
		    const open = openId === r.id;
		    const idShown = shortId(r);
		    const idKey = `id:${r.id}`;
		    return (0, import_react.createElement)(
		      "div",
		      { key: r.id, className: "bt-fsess" },
		      (0, import_react.createElement)(
		        "div",
		        { className: "bt-fsess-line1" },
		        (0, import_react.createElement)("span", {
		          className: "bt-fsess-title",
		          role: "button",
		          tabIndex: 0,
		          "aria-expanded": open,
		          title: r.title !== "" ? r.title : r.id,
		          onClick: () => toggleRow(r, open),
		          onKeyDown: (e) => {
		            if (e.key === "Enter" || e.key === " ") {
		              e.preventDefault();
		              toggleRow(r, open);
		            }
		          }
		        }, r.title !== "" ? r.title : idShown),
		        (0, import_react.createElement)("span", { className: "bt-fsess-time" }, relTime(r.updatedAt, now, lang))
		      ),
		      (0, import_react.createElement)(
		        "div",
		        { className: "bt-fsess-line2" },
		        (0, import_react.createElement)("span", {
		          className: "bt-fsess-src",
		          title: r.cwd !== "" ? r.cwd : void 0
		        }, r.cwd === "" ? "\u2014" : r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd),
		        (0, import_react.createElement)("span", {
		          className: "bt-fsess-id",
		          role: "button",
		          tabIndex: 0,
		          title: t("copyIdTitle"),
		          onClick: () => copy(idKey, r.id),
		          onKeyDown: (e) => {
		            if (e.key === "Enter" || e.key === " ") {
		              e.preventDefault();
		              copy(idKey, r.id);
		            }
		          }
		        }, copied === idKey ? t("copiedBtn") : idShown),
		        (0, import_react.createElement)(
		          "span",
		          { className: "bt-fsess-act" },
		          (0, import_react.createElement)(
		            "button",
		            {
		              className: "bt-btn bt-btn-xs bt-btn-primary",
		              type: "button",
		              disabled: busyKey !== null,
		              title: t("takeoverTitle"),
		              onClick: () => runTakeover(`take:${r.id}`, "take", r.id)
		            },
		            deliveredKey === `take:${r.id}` ? t("deliveredBtn") : busyKey === `take:${r.id}` ? t("deliveringBtn") : copied === `take:${r.id}` ? t("fallbackCopyBtn") : t("takeoverBtn")
		          ),
		          (0, import_react.createElement)(
		            "button",
		            {
		              className: "bt-btn bt-btn-xs",
		              type: "button",
		              disabled: busyKey !== null,
		              title: t("depositTitle"),
		              onClick: () => runTakeover(`dep:${r.id}`, "take_deposit", r.id)
		            },
		            deliveredKey === `dep:${r.id}` ? t("deliveredBtn") : busyKey === `dep:${r.id}` ? t("deliveringBtn") : copied === `dep:${r.id}` ? t("fallbackCopyBtn") : t("depositBtn")
		          )
		        )
		      ),
		      open ? previewNode(r.id) : null
		    );
		  };
		  const matched = list !== void 0 ? filterSessions(list.sessions, query) : [];
		  const facets = list !== void 0 ? cwdFacets(matched) : [];
		  const cwdEffective = facets.some((f) => f.cwd === cwdSel) ? cwdSel : null;
		  const visible = filterByCwd(matched, cwdEffective).filter((r) => !isSubagentSession(r));
		  const subRows = filterByCwd(matched, cwdEffective).filter(isSubagentSession);
		  const subGroupNode = subRows.length > 0 ? (0, import_react.createElement)(
		    "div",
		    { className: "bt-group", key: "fs-sub" },
		    (0, import_react.createElement)(
		      "div",
		      {
		        className: `bt-pending${subOpen ? " bt-pending-open" : ""}`,
		        role: "button",
		        tabIndex: 0,
		        "aria-expanded": subOpen,
		        "aria-label": t("subagentGroup", { n: subRows.length }),
		        onClick: () => setSubOpen(!subOpen),
		        onKeyDown: (e) => {
		          if (e.key === "Enter" || e.key === " ") {
		            e.preventDefault();
		            setSubOpen(!subOpen);
		          }
		        }
		      },
		      (0, import_react.createElement)("span", { className: "bt-tag bt-tag-lowinfo" }, t("subagentBadge")),
		      (0, import_react.createElement)("span", { className: "bt-pending-title" }, t("subagentGroup", { n: subRows.length })),
		      (0, import_react.createElement)("span", { className: "bt-pending-chev", "aria-hidden": true }, "\u25B8")
		    ),
		    subOpen ? subRows.map(rowNode) : null
		  ) : null;
		  return (0, import_react.createElement)(
		    "div",
		    { className: "bt-card" },
		    (0, import_react.createElement)(
		      "div",
		      { className: "bt-head" },
		      (0, import_react.createElement)("span", { className: "bt-title", style: { fontSize: 13 } }, t("browserTitle"))
		    ),
		    (0, import_react.createElement)("div", { className: "bt-sub" }, t("browserHint")),
		    (0, import_react.createElement)(
		      "div",
		      { className: "bt-chips", role: "group", "aria-label": t("browserChipAria"), style: { marginTop: 8 } },
		      ...providers.map((p) => {
		        const usable = p.supported && p.enabled;
		        return (0, import_react.createElement)(
		          "button",
		          {
		            key: p.name,
		            className: `bt-chip${sel === p.name ? " bt-chip-on" : ""}${usable ? "" : " bt-chip-off"}`,
		            disabled: !usable,
		            "aria-pressed": sel === p.name,
		            type: "button",
		            title: !usable ? t("browserDisabledTitle", { label: PROVIDER_LABEL[p.name] ?? p.name }) : p.supported && p.note !== "" ? p.note : void 0,
		            onClick: () => {
		              setSel(p.name);
		              setOpenId(null);
		              setCwdSel(null);
		              if (lists[p.name] === void 0 && loading[p.name] !== true) load(p.name);
		            }
		          },
		          (0, import_react.createElement)("span", { className: "bt-chip-label" }, PROVIDER_LABEL[p.name] ?? p.name),
		          (0, import_react.createElement)("span", { className: "bt-chip-count" }, p.sessions >= 0 ? String(p.sessions) : "\u2026")
		        );
		      })
		    ),
		    sel === null || list === void 0 ? (0, import_react.createElement)("div", { className: "bt-sub bt-fs-empty" }, sel === null ? t("browserPick") : t("loading")) : [
		      (0, import_react.createElement)(
		        "div",
		        { className: "bt-inbox-toolbar", key: "fs-bar" },
		        (0, import_react.createElement)("input", {
		          className: "bt-filter",
		          type: "search",
		          value: query,
		          placeholder: t("filterSessionsPlaceholder"),
		          "aria-label": t("filterSessionsAria"),
		          title: t("filterSessionsAria"),
		          onChange: (e) => {
		            setQuery(e.target.value);
		          }
		        }),
		        (0, import_react.createElement)("button", {
		          className: "bt-btn",
		          type: "button",
		          disabled: loading[provider] === true,
		          onClick: () => {
		            setOpenId(null);
		            load(provider);
		          }
		        }, loading[provider] === true ? t("loading") : t("refresh"))
		      ),
		      (0, import_react.createElement)(
		        "div",
		        { className: "bt-sub bt-fs-count", key: "fs-count" },
		        list.total === 0 ? t("browserEmpty") : t("browserTotal", { m: list.total, n: list.sessions.length }),
		        list.note !== void 0 ? ` \xB7 ${t("browserNote", { note: list.note })}` : ""
		      ),
		      list.total > 0 && facets.length > 1 ? (0, import_react.createElement)(
		        "div",
		        { className: "bt-chips", key: "fs-cwd", role: "group", "aria-label": t("facetCwdAria"), style: { marginTop: 6 } },
		        ...facets.map((f) => (0, import_react.createElement)(
		          "button",
		          {
		            key: f.cwd === "" ? "(empty)" : f.cwd,
		            className: `bt-chip${cwdEffective === f.cwd ? " bt-chip-on" : ""}`,
		            "aria-pressed": cwdEffective === f.cwd,
		            type: "button",
		            title: f.cwd === "" ? void 0 : f.cwd,
		            onClick: () => setCwdSel(cwdEffective === f.cwd ? null : f.cwd)
		          },
		          (0, import_react.createElement)("span", { className: "bt-chip-label" }, f.label),
		          (0, import_react.createElement)("span", { className: "bt-chip-count" }, String(f.count))
		        ))
		      ) : null,
		      list.total > 0 && matched.length === 0 ? (0, import_react.createElement)("div", { className: "bt-banner bt-banner-info", key: "fs-nomatch" }, t("browserFilterEmpty")) : (0, import_react.createElement)("div", { key: "fs-rows" }, visible.map(rowNode), subGroupNode)
		    ]
		  );
		}
		var RESUME_PROVIDERS = ["claude", "codex", "opencode", "zcode", "pi", "workbuddy", "cursor", "grok"];
		function CommandsCard({ state, t }) {
		  const disabled = new Set(
		    (state?.providers ?? []).filter((p) => !p.enabled).map((p) => p.name)
		  );
		  const chip = (cmd, desc, provider, primary = false) => {
		    const off = provider !== void 0 && disabled.has(provider);
		    const label = provider !== void 0 ? PROVIDER_LABEL[provider] ?? provider : void 0;
		    return (0, import_react.createElement)(
		      "div",
		      {
		        key: cmd,
		        className: `bt-cmd${off ? " bt-cmd-off" : ""}`,
		        title: off && label !== void 0 ? t("cmdOffTitle", { label }) : void 0
		      },
		      provider !== void 0 ? (0, import_react.createElement)(ProviderIcon, { name: provider }) : (0, import_react.createElement)(
		        "span",
		        { className: "bt-icon", style: { width: 16, height: 16, background: "var(--bt-a, #2563eb)" } },
		        (0, import_react.createElement)(
		          "svg",
		          { viewBox: "0 0 64 64", width: 10, height: 10, "aria-hidden": true },
		          (0, import_react.createElement)("rect", { x: 12, y: 26.5, width: 40, height: 11, rx: 5.5, fill: "#fff", transform: "rotate(-45 32 32)" })
		        )
		      ),
		      (0, import_react.createElement)("span", { className: `bt-cmd-key${primary ? " bt-cmd-key-primary" : ""}` }, cmd),
		      (0, import_react.createElement)("span", { className: "bt-cmd-desc" }, desc)
		    );
		  };
		  return (0, import_react.createElement)(
		    "div",
		    { className: "bt-card" },
		    (0, import_react.createElement)(
		      "div",
		      { className: "bt-head" },
		      (0, import_react.createElement)("span", { className: "bt-title", style: { fontSize: 13 } }, t("cmdTitle")),
		      (0, import_react.createElement)("span", { className: "bt-badge" }, t("cmdBadge"))
		    ),
		    (0, import_react.createElement)(
		      "div",
		      { className: "bt-cmds" },
		      chip("/handoff", t("cmdHandoffDesc"), void 0, true),
		      chip("/inbox", t("cmdInboxDesc"), void 0, true),
		      ...RESUME_PROVIDERS.map((p) => chip(`/resume-${p}`, t("cmdResumeDesc", { name: PROVIDER_LABEL[p] ?? p }), p))
		    )
		  );
		}
		var PanelBoundary = class extends import_react.Component {
		  state = { err: null };
		  static getDerivedStateFromError(err) {
		    return { err };
		  }
		  render() {
		    if (this.state.err !== null) {
		      const e = this.state.err;
		      return (0, import_react.createElement)(
		        "div",
		        { className: "bt-panel", style: themeVars() },
		        (0, import_react.createElement)("style", null, CSS),
		        (0, import_react.createElement)(
		          "div",
		          { className: "bt-card" },
		          (0, import_react.createElement)("div", { className: "bt-title" }, this.props.t("renderErrorTitle")),
		          (0, import_react.createElement)(
		            "pre",
		            { style: { fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, lineHeight: 1.5 } },
		            e.stack ?? e.message ?? String(this.state.err)
		          )
		        )
		      );
		    }
		    return this.props.children;
		  }
		};
		function Panel({ t, locale }) {
		  const [state, setState] = (0, import_react.useState)(null);
		  const [error, setError] = (0, import_react.useState)(null);
		  const [busy, setBusy] = (0, import_react.useState)(null);
		  const [confirmClear, setConfirmClear] = (0, import_react.useState)(false);
		  const [query, setQuery] = (0, import_react.useState)("");
		  const [takeBusyId, setTakeBusyId] = (0, import_react.useState)(null);
		  const [notice, setNotice] = (0, import_react.useState)(null);
		  const noticeTimer = (0, import_react.useRef)(void 0);
		  const showNotice = (msg) => {
		    setNotice(msg);
		    window.clearTimeout(noticeTimer.current);
		    noticeTimer.current = window.setTimeout(() => setNotice(null), 8e3);
		  };
		  const takeInbox = (p) => {
		    if (takeBusyId !== null) return;
		    setTakeBusyId(p.id);
		    void post("/dsh-takeover/takeover", { mode: "inbox", reference: p.id }).then((r) => {
		      if (!r.ok) throw new Error(r.error);
		      showNotice(t("deliveredNotice", { title: r.title }));
		      return void 0;
		    }).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setTakeBusyId(null));
		  };
		  (0, import_react.useSyncExternalStore)(
		    (cb) => {
		      try {
		        return locale?.subscribe(cb) ?? (() => {
		        });
		      } catch {
		        return (() => {
		        });
		      }
		    },
		    () => {
		      try {
		        return locale?.getSnapshot().revision ?? 0;
		      } catch {
		        return 0;
		      }
		    }
		  );
		  const lang = langOf(locale);
		  const generationRef = (0, import_react.useRef)(0);
		  const reload = () => {
		    const gen = ++generationRef.current;
		    void getState().then(
		      (s) => {
		        if (gen !== generationRef.current) return;
		        setState(s);
		        setError(null);
		      },
		      (e) => {
		        if (gen !== generationRef.current) return;
		        setError(e instanceof Error ? e.message : String(e));
		      }
		    );
		  };
		  (0, import_react.useEffect)(reload, []);
		  (0, import_react.useEffect)(() => {
		    const timer = window.setInterval(() => {
		      try {
		        if (document.visibilityState === "visible") reload();
		      } catch {
		      }
		    }, 3e4);
		    return () => {
		      window.clearInterval(timer);
		    };
		  }, []);
		  const toggle = (name, enabled) => {
		    setBusy(name);
		    const gen = ++generationRef.current;
		    void post("/dsh-takeover/provider", { provider: name, enabled }).then((r) => {
		      if (gen !== generationRef.current) return;
		      setState(r.state);
		      setError(null);
		    }).catch((e) => {
		      if (gen !== generationRef.current) return;
		      setError(e instanceof Error ? e.message : String(e));
		    }).finally(() => {
		      setBusy(null);
		    });
		  };
		  const clear = () => {
		    if (!confirmClear) {
		      setConfirmClear(true);
		      setTimeout(() => {
		        setConfirmClear(false);
		      }, 3e3);
		      return;
		    }
		    setConfirmClear(false);
		    setBusy("clear");
		    void post("/dsh-takeover/clear-archived", {}).then(() => {
		      reload();
		    }).catch((e) => {
		      setError(e instanceof Error ? e.message : String(e));
		    }).finally(() => {
		      setBusy(null);
		    });
		  };
		  const archivedCount = state?.archivedCount ?? 0;
		  const envelopeChars = state !== null ? envelopeCharsOf(state) : null;
		  const coverage = state !== null ? coverageTextOf(state) : null;
		  const exportNotes = () => ({
		    top: t("exportNoteTop"),
		    missing: t("exportSectionMissing")
		  });
		  const exportOne = (p) => {
		    try {
		      downloadText(`${p.id}.md`, cardMarkdown(p, exportNotes()));
		    } catch (e) {
		      setError(e instanceof Error ? e.message : String(e));
		    }
		  };
		  const exportAll = () => {
		    if (state === null || state.pending.length === 0) return;
		    try {
		      downloadText(`handoff-pending-${exportStamp()}.md`, pendingListMarkdown(state.pending, exportNotes()));
		    } catch (e) {
		      setError(e instanceof Error ? e.message : String(e));
		    }
		  };
		  const exportHtmlReport = () => {
		    if (state === null) return;
		    try {
		      const d = /* @__PURE__ */ new Date();
		      downloadText(
		        `handoff-report-${exportStamp(d)}.html`,
		        buildReportHtml(state, reportWords(lang), lang, absTime(d.toISOString())),
		        "text/html;charset=utf-8"
		      );
		    } catch (e) {
		      setError(e instanceof Error ? e.message : String(e));
		    }
		  };
		  return (0, import_react.createElement)(
		    "div",
		    { className: "bt-panel", style: themeVars() },
		    (0, import_react.createElement)("style", null, CSS),
		    // 头卡：标识 + 刷新
		    (0, import_react.createElement)(
		      "div",
		      { className: "bt-card" },
		      (0, import_react.createElement)(
		        "div",
		        { className: "bt-head" },
		        (0, import_react.createElement)("span", { className: "bt-logo", dangerouslySetInnerHTML: { __html: ICON_SVG } }),
		        (0, import_react.createElement)(
		          "span",
		          null,
		          (0, import_react.createElement)("div", { className: "bt-title" }, t("appTitle")),
		          (0, import_react.createElement)("div", { className: "bt-sub" }, t("appSubtitle"))
		        ),
		        (0, import_react.createElement)("span", { className: "bt-spacer" }),
		        (0, import_react.createElement)("button", { className: "bt-btn", onClick: reload, disabled: busy !== null }, t("refresh"))
		      ),
		      error !== null ? (0, import_react.createElement)("div", { className: "bt-banner bt-banner-err" }, error) : null,
		      notice !== null ? (0, import_react.createElement)("div", { className: "bt-banner bt-banner-info" }, notice) : null
		    ),
		    // 命令速览（直接可见）
		    (0, import_react.createElement)(CommandsCard, { state, t }),
		    // 收件箱概览
		    (0, import_react.createElement)(
		      "div",
		      { className: "bt-card" },
		      (0, import_react.createElement)(
		        "div",
		        { className: "bt-head" },
		        (0, import_react.createElement)("span", { className: "bt-title", style: { fontSize: 13 } }, t("inboxTitle")),
		        (0, import_react.createElement)("span", { className: "bt-spacer" }),
		        (0, import_react.createElement)("button", {
		          className: `bt-btn bt-btn-danger${confirmClear ? " bt-btn-confirm" : ""}`,
		          disabled: busy !== null || archivedCount === 0,
		          onClick: clear,
		          title: t("clearArchivedTitle")
		        }, confirmClear ? t("clearConfirm", { n: archivedCount }) : t("clearArchived"))
		      ),
		      // 统计条：四格横排（待取件 / 已消费 / 账本覆盖 / 信封），一个元素一行信息
		      state !== null ? (0, import_react.createElement)(
		        "div",
		        { className: "bt-statstrip" },
		        (0, import_react.createElement)("span", {
		          className: `bt-stat${(state?.pending.length ?? 0) > 0 ? " bt-stat-hot" : ""}`,
		          title: t("pendingDirHint")
		        }, t("badgePending", { n: state?.pending.length ?? "\u2026" })),
		        (0, import_react.createElement)("span", {
		          className: "bt-stat",
		          title: t("archivedDirHint")
		        }, t("badgeArchived", { n: archivedCount })),
		        coverage !== null ? (0, import_react.createElement)(
		          "span",
		          { className: "bt-stat", title: t("coverageBadgeTitle") },
		          t("coverageBadge", { v: coverage })
		        ) : null,
		        envelopeChars !== null ? (0, import_react.createElement)(
		          "span",
		          { className: "bt-stat", title: t("envelopeArchived", { n: envelopeChars }) },
		          t("envelopeArchived", { n: envelopeChars })
		        ) : null,
		        (state?.pendingDuplicates ?? 0) > 0 ? (0, import_react.createElement)(
		          "span",
		          { className: "bt-stat bt-stat-warn", title: t("pendingDupTitle") },
		          t("pendingDupChip", { n: state.pendingDuplicates })
		        ) : null
		      ) : null,
		      // 工具行：即时过滤 + 导出全部 + 导出 HTML 报告
		      state !== null ? (0, import_react.createElement)(
		        "div",
		        { className: "bt-inbox-toolbar" },
		        (0, import_react.createElement)("input", {
		          className: "bt-filter",
		          type: "search",
		          value: query,
		          placeholder: t("filterPlaceholder"),
		          "aria-label": t("filterAria"),
		          title: t("filterAria"),
		          onChange: (e) => {
		            setQuery(e.target.value);
		          }
		        }),
		        (0, import_react.createElement)("button", {
		          className: "bt-btn",
		          disabled: state.pending.length === 0,
		          onClick: exportAll,
		          title: t("exportAllTitle")
		        }, t("exportAll")),
		        (0, import_react.createElement)("button", {
		          className: "bt-btn",
		          onClick: exportHtmlReport,
		          title: t("exportHtmlTitle")
		        }, t("exportHtml"))
		      ) : null,
		      state !== null ? (0, import_react.createElement)(PendingList, {
		        rows: state.pending,
		        query,
		        home: state.home,
		        t,
		        lang,
		        onExport: exportOne,
		        onChainFilter: (id) => {
		          setQuery(id);
		        },
		        onTakeInbox: takeInbox,
		        takeBusyId
		      }) : (0, import_react.createElement)("div", { className: "bt-sub" }, t("loading"))
		    ),
		    // 外部会话浏览器（浏览 + 一键投递；卡片蒸馏仍在会话里由模型完成）
		    (0, import_react.createElement)(ForeignBrowser, { state, t, lang, onError: (msg) => setError(msg), onNotice: showNotice }),
		    // 支持矩阵
		    (0, import_react.createElement)(
		      "div",
		      { className: "bt-card" },
		      (0, import_react.createElement)(
		        "div",
		        { className: "bt-head" },
		        (0, import_react.createElement)("span", { className: "bt-title", style: { fontSize: 13 } }, t("matrixTitle"))
		      ),
		      state !== null ? (0, import_react.createElement)(ProviderMatrix, { rows: state.providers, busy, onToggle: toggle, t }) : (0, import_react.createElement)("div", { className: "bt-sub" }, t("loading")),
		      (0, import_react.createElement)(
		        "details",
		        { className: "bt-note" },
		        (0, import_react.createElement)("summary", null, t("noteSummary")),
		        (0, import_react.createElement)("div", { className: "bt-note-body" }, t("noteBody"))
		      )
		    )
		  );
		}
		function apply(ctx) {
		  const slots = ctx.slots;
		  if (slots === null || typeof slots !== "object" || typeof slots.inject !== "function" || typeof slots.register !== "function") {
		    console.warn("[dsh-takeover] \u5BBF\u4E3B\u672A\u63D0\u4F9B\u53EF\u7528\u7684 slots \u670D\u52A1\uFF08\u9700\u8981 @deepseek-ai/dsh-client-ui-renderer\uFF09\uFF0C\u8BBE\u7F6E\u5361\u8DF3\u8FC7\u6302\u8F7D");
		    return;
		  }
		  ctx.slots.inject("settings.section", () => ctx.slots.register(
		    { name: "settings.section", id: "dsh-takeover", order: 42, label: "dsh-takeover" },
		    () => {
		      const t = makeT(ctx);
		      return (0, import_react.createElement)(PanelBoundary, {
		        t,
		        children: (0, import_react.createElement)(Panel, { t, locale: resolveLocale(ctx) })
		      });
		    }
		  ));
		}
		
		return module.exports;
	}
});
